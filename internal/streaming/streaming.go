package streaming

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
)

// reSubsPlaylist and reSubsSegment lock subtitle filenames to the exact
// shape FFmpeg produces: subs_<index>.m3u8 and subs_<track>_<segment>.vtt.
// The previous prefix/suffix check ("subs_" + ".m3u8") accepted anything in
// the middle — including unicode tricks that Chi has already URL-decoded
// before we see them. Restricting to digits prevents accidental overlap
// with future FFmpeg outputs and removes a small path-confusion surface.
var (
	reSubsPlaylist = regexp.MustCompile(`^subs_\d+\.m3u8$`)
	reSubsSegment  = regexp.MustCompile(`^subs_\d+_\d+\.vtt$`)
)

// DirectPlayCodecs lists video codecs with reliable cross-browser support
// for the STATIC fallback path (nil clientCaps). HEVC is excluded here because
// the static path has no way to know if the browser supports it. When client
// capabilities are provided, the client-aware DecidePlayback engine handles
// HEVC via direct play (MP4) or remux (MKV → HLS .ts with hevc_mp4toannexb BSF)
// depending on the browser's reported codec support.
var DirectPlayCodecs = map[string]bool{
	"h264": true, "avc": true, "avc1": true,
	"vp8": true, "vp9": true,
	"av1": true,
}

// DirectPlayContainers lists containers browsers handle natively.
var DirectPlayContainers = map[string]bool{
	"mp4": true, "webm": true, "mov": true,
}

// DirectPlayAudioCodecs lists audio codecs safe for both direct play AND HLS
// .ts passthrough. The static fallback (nil clientCaps) uses this for both
// paths, so only include codecs that HLS.js's TS demuxer can extract:
// AAC and MP3. AC-3 requires the M2TS_ADVANCED_CODECS build flag and is
// better handled by the client-aware path. Opus, Vorbis, and FLAC cannot
// be demuxed from .ts by HLS.js — they must go through the client-aware
// path where they're valid for direct play but not for HLS passthrough.
var DirectPlayAudioCodecs = map[string]bool{
	"aac": true, "mp3": true,
}

// containerAliases maps FFprobe format names to canonical container names.
// FFprobe returns multi-format strings like "mov,mp4,m4a,3gp,3g2,mj2" and
// non-standard names like "matroska" for MKV. This normalizes them to short
// names used in DirectPlayContainers and throughout Aurora.
var containerAliases = map[string]string{
	"matroska": "mkv",
	"webm":     "webm",
	"mov":      "mp4",
	"mp4":      "mp4",
	"avi":      "avi",
	"mpegts":   "ts",
	"ogg":      "ogg",
}

// NormalizeContainer converts FFprobe format names to canonical short names.
// FFprobe may return comma-separated format lists (e.g., "mov,mp4,m4a,3gp,3g2,mj2").
// Only the first format is used. Unknown formats are returned as-is (lowercase).
func NormalizeContainer(ffprobeFormat string) string {
	c := strings.ToLower(strings.TrimSpace(ffprobeFormat))
	// FFprobe may return comma-separated format names; use the first one.
	if idx := strings.IndexByte(c, ','); idx >= 0 {
		c = c[:idx]
	}
	if alias, ok := containerAliases[c]; ok {
		return alias
	}
	return c
}

// CanDirectPlay checks if a file can be served directly without any processing.
// Validates container, video codec, and audio codec are all browser-compatible.
func CanDirectPlay(container, videoCodec, audioCodec string) bool {
	c := NormalizeContainer(container)
	v := strings.ToLower(videoCodec)
	a := strings.ToLower(audioCodec)
	return DirectPlayContainers[c] && DirectPlayCodecs[v] && DirectPlayAudioCodecs[a]
}

// --- Client-Aware Playback Decision Engine ---

// ClientCaps represents a browser's codec capabilities, reported by the frontend
// via MediaSource.isTypeSupported / canPlayType probing.
type ClientCaps struct {
	VideoCodecs map[string]bool // e.g. "h264", "h265", "vp9", "av1"
	AudioCodecs map[string]bool // e.g. "aac", "mp3", "opus", "ac3", "eac3"
	Containers  map[string]bool // e.g. "mp4_container", "webm_container"
	HLSNative   bool
	HLSJS       bool
}

// PlaybackDecision is the result of analyzing a file against client capabilities.
type PlaybackDecision struct {
	Decision         string // "direct_play", "direct_stream", "transcode"
	TranscodeReason  string // human-readable reason (empty if direct_play)
	AudioTrackIndex  int    // 0-based index of recommended audio track (-1 = default/first)
	AudioNeedsRecode bool   // true if the chosen audio track needs transcoding
	Remux            bool   // true if decision is direct_stream
	AudioPassthrough bool   // true if audio can be copied as-is
}

var knownVideoCodecs = map[string]bool{
	"h264": true, "h265": true, "hevc": true, "vp8": true, "vp9": true, "av1": true,
}

var knownAudioCodecs = map[string]bool{
	"aac": true, "mp3": true, "opus": true, "vorbis": true, "flac": true, "ac3": true, "eac3": true,
}

// ParseClientCaps parses the comma-separated capabilities string from the frontend.
// Unknown keys are silently ignored for forward compatibility.
func ParseClientCaps(raw string) *ClientCaps {
	caps := &ClientCaps{
		VideoCodecs: make(map[string]bool),
		AudioCodecs: make(map[string]bool),
		Containers:  make(map[string]bool),
	}
	for _, key := range strings.Split(raw, ",") {
		key = strings.TrimSpace(strings.ToLower(key))
		if key == "" {
			continue
		}
		switch {
		case key == "hls_native":
			caps.HLSNative = true
		case key == "hls_js":
			caps.HLSJS = true
		case strings.HasSuffix(key, "_container"):
			caps.Containers[key] = true
		case knownVideoCodecs[key]:
			caps.VideoCodecs[key] = true
			// Sync hevc/h265 aliases
			if key == "hevc" {
				caps.VideoCodecs["h265"] = true
			} else if key == "h265" {
				caps.VideoCodecs["hevc"] = true
			}
		case knownAudioCodecs[key]:
			caps.AudioCodecs[key] = true
		}
	}
	return caps
}

// DecidePlayback evaluates a file's codecs against client capabilities and returns
// the optimal playback strategy. If clientCaps is nil, falls back to static
// allowlists for backward compatibility.
//
// pixFmt is the video pixel format from FFprobe (e.g., "yuv420p", "yuv420p10le").
// It is used to detect H.264 10-bit (Hi10P) files which browsers universally reject
// via MediaSource API, even though ffprobe reports the codec as plain "h264".
// Pass an empty string if unknown.
func DecidePlayback(container, videoCodec string, audioTracks []models.AudioTrack, clientCaps *ClientCaps, pixFmt ...string) PlaybackDecision {
	nc := NormalizeContainer(container)
	vc := strings.ToLower(videoCodec)

	// Extract optional pixFmt (variadic for backward compatibility)
	videoPixFmt := ""
	if len(pixFmt) > 0 {
		videoPixFmt = strings.ToLower(pixFmt[0])
	}

	// Determine primary audio codec (first track, backward compat)
	primaryAudio := ""
	if len(audioTracks) > 0 {
		primaryAudio = strings.ToLower(audioTracks[0].Codec)
	}

	// If no client caps provided, use static allowlists (backward compat)
	if clientCaps == nil {
		return decideStatic(nc, vc, primaryAudio, videoPixFmt)
	}

	// Check video codec support with alias handling
	videoOK := clientCaps.VideoCodecs[vc]
	if !videoOK && (vc == "hevc" || vc == "h265") {
		videoOK = clientCaps.VideoCodecs["h265"] || clientCaps.VideoCodecs["hevc"]
	}
	if !videoOK && (vc == "avc" || vc == "avc1") {
		videoOK = clientCaps.VideoCodecs["h264"]
	}

	// H.264 10-bit (Hi10P) guard: browsers' MediaSource API universally rejects
	// H.264 High 10 Profile. FFprobe reports the codec as just "h264" so the
	// above check thinks MSE can handle it. Detect 10-bit via pix_fmt containing
	// "10" (e.g., "yuv420p10le", "yuv422p10le") and force full transcode to 8-bit.
	isH264_10bit := (vc == "h264" || vc == "avc" || vc == "avc1") && strings.Contains(videoPixFmt, "10")
	if isH264_10bit {
		videoOK = false // MSE/direct play will not work
	}

	// HEVC remux: HLS.js v1.6.0+ can demux HEVC NAL units from MPEG-TS
	// (.ts) segments. Aurora's frontend ships HLS.js v1.6.15, so HEVC
	// remux (MKV HEVC → HLS .ts with -c:v copy + hevc_mp4toannexb BSF)
	// is safe when the client reports HEVC support via caps. The videoOK
	// check above already gates on clientCaps.VideoCodecs["h265"/"hevc"],
	// so no additional guard is needed for HEVC.
	remuxVideoOK := videoOK
	// H.264 10-bit cannot be remuxed — the browser rejects the encoded data
	if isH264_10bit {
		remuxVideoOK = false
	}
	// VP8/VP9/AV1 cannot be remuxed into .ts segments — HLS.js's TS demuxer
	// only supports H.264 and HEVC NAL units. These codecs work in their
	// native containers (WebM/MP4) for direct play, but the HLS remux path
	// produces .ts segments that HLS.js cannot demux. Force full transcode.
	if clientCaps.HLSJS && (vc == "vp8" || vc == "vp9" || vc == "av1") {
		remuxVideoOK = false
	}

	// Check container support
	containerOK := false
	switch nc {
	case "mp4":
		containerOK = clientCaps.Containers["mp4_container"]
	case "webm":
		containerOK = clientCaps.Containers["webm_container"]
	case "mov":
		containerOK = clientCaps.Containers["mp4_container"] // browsers treat mov ≈ mp4
	}

	// --- Direct play check (uses FULL client caps) ---
	// Direct play serves the original file — no HLS, no .ts segments.
	// The browser plays natively, so all MSE-reported codecs are valid.
	dpIdx, _, dpAudioOK, dpIsDefault := findBestAudioTrack(audioTracks, clientCaps)
	if videoOK && containerOK && dpAudioOK && dpIsDefault {
		return PlaybackDecision{
			Decision:         "direct_play",
			AudioTrackIndex:  dpIdx,
			AudioPassthrough: true,
		}
	}

	// --- HLS paths (remux / transcode) use HLS.js-restricted audio caps ---
	//
	// The frontend uses HLS.js whenever Hls.isSupported() is true, even on
	// browsers that ALSO support native HLS (e.g., macOS Safari). HLS.js
	// v1.5.17's TS demuxer can only extract AAC, MP3, and AC-3 from .ts
	// segments. Even if the browser's MSE API reports EAC3/FLAC/Opus/Vorbis
	// as supported, HLS.js cannot demux them from .ts — playback produces
	// silent audio or errors.
	//
	// Only clients with HLSJS=false (e.g., iOS Safari) use native HLS,
	// which supports all codecs the browser reports.
	hlsCaps := clientCaps
	if clientCaps.HLSJS {
		hlsCaps = &ClientCaps{
			VideoCodecs: clientCaps.VideoCodecs,
			Containers:  clientCaps.Containers,
			HLSNative:   clientCaps.HLSNative,
			HLSJS:       clientCaps.HLSJS,
			AudioCodecs: map[string]bool{
				"aac": clientCaps.AudioCodecs["aac"],
				"mp3": clientCaps.AudioCodecs["mp3"],
				"ac3": clientCaps.AudioCodecs["ac3"],
			},
		}
	}

	bestIdx, bestCodec, audioOK, isDefaultTrack := findBestAudioTrack(audioTracks, hlsCaps)

	// tsPassthroughSafe narrows the remux "copy audio into .ts" policy. HLS.js
	// can *demux* mp3 from MPEG-TS, so audioOK is true for mp3 sources — but:
	//   - Safari's native HLS decoder rejects or silently drops mp3-in-ts on
	//     some OS versions.
	//   - Non-standard sample-rate mp3 (22.05/24 kHz, common in older MKVs)
	//     has framing edge cases across both Safari and hls.js.
	// Re-encoding mp3→AAC on the remux path costs ~1% of a core and produces a
	// format that every consumer accepts. The risk is not worth the savings.
	tsPassthroughSafe := func(codec string) bool {
		return codec == "aac" || codec == "ac3"
	}

	// For remux paths below, use remuxVideoOK instead of videoOK.
	// This ensures HEVC files on HLS.js clients fall through to full
	// transcode rather than producing unplayable .ts segments.

	if remuxVideoOK && containerOK && audioOK && !isDefaultTrack {
		// Video + container OK, audio IS compatible but only a non-default
		// track. Must remux to select the compatible track via -map 0:a:N.
		// Force mp3 → AAC even here; see tsPassthroughSafe above.
		safe := tsPassthroughSafe(bestCodec)
		reason := fmt.Sprintf("compatible audio track %d is not the default; remux needed to select it", bestIdx)
		if !safe {
			reason = fmt.Sprintf("compatible audio track %d (%s) is not the default and mp3 is not ts-safe; remux + audio recode", bestIdx, bestCodec)
		}
		return PlaybackDecision{
			Decision:         "direct_stream",
			TranscodeReason:  reason,
			AudioTrackIndex:  bestIdx,
			AudioNeedsRecode: !safe,
			Remux:            true,
			AudioPassthrough: safe,
		}
	}

	if remuxVideoOK && containerOK && !audioOK {
		// Video + container OK, but audio needs transcoding → remux for audio
		return PlaybackDecision{
			Decision:         "direct_stream",
			TranscodeReason:  fmt.Sprintf("audio codec %q not supported by HLS.js TS demuxer", bestCodec),
			AudioTrackIndex:  bestIdx,
			AudioNeedsRecode: true,
			Remux:            true,
			AudioPassthrough: false,
		}
	}

	if remuxVideoOK && !containerOK {
		// Video OK but container needs remuxing (e.g., MKV → HLS).
		// Audio passthrough is only safe for AAC/AC-3; mp3 is force-recoded.
		safe := audioOK && tsPassthroughSafe(bestCodec)
		reason := fmt.Sprintf("container %q not natively supported", nc)
		if audioOK && !safe {
			reason = fmt.Sprintf("container %q not natively supported; audio %q forced to AAC for ts-safety", nc, bestCodec)
		}
		return PlaybackDecision{
			Decision:         "direct_stream",
			TranscodeReason:  reason,
			AudioTrackIndex:  bestIdx,
			AudioNeedsRecode: !safe,
			Remux:            true,
			AudioPassthrough: safe,
		}
	}

	// Video codec not supported (or HEVC/VP9/AV1 on HLS.js client, or H.264 10-bit) → full transcode
	reason := fmt.Sprintf("video codec %q not supported by browser", vc)
	if isH264_10bit {
		reason = "H.264 10-bit (Hi10P) not supported by browser MediaSource API; transcoding to 8-bit H.264"
	} else if videoOK && !remuxVideoOK && (vc == "vp8" || vc == "vp9" || vc == "av1") {
		reason = fmt.Sprintf("%s remux into HLS .ts segments not supported by HLS.js TS demuxer; transcoding to H.264", strings.ToUpper(vc))
	}
	// Full-transcode path: audio passthrough is only safe when the source codec
	// already matches the `mp4a.40.2` (AAC-LC) string that hlsCodecString()
	// advertises in the master playlist. Any other codec — notably MP3, which
	// `audioOK` evaluates true for under the HLS.js caps — would land in the
	// .ts segments while the manifest promises AAC, causing `bufferAppendError`
	// in HLS.js's MSE SourceBuffer. For AAC sources we copy (cheap); for
	// anything else we re-encode to AAC (matches manifest).
	aacSource := bestCodec == "aac"
	return PlaybackDecision{
		Decision:         "transcode",
		TranscodeReason:  reason,
		AudioTrackIndex:  bestIdx,
		AudioNeedsRecode: !aacSource,
		AudioPassthrough: aacSource,
	}
}

// decideStatic is the backward-compatible fallback using static allowlists.
func decideStatic(container, videoCodec, audioCodec, pixFmt string) PlaybackDecision {
	// H.264 10-bit: browsers universally reject this via MSE. Force transcode.
	isH264_10bit := (videoCodec == "h264" || videoCodec == "avc" || videoCodec == "avc1") && strings.Contains(pixFmt, "10")
	if isH264_10bit {
		return PlaybackDecision{
			Decision:         "transcode",
			TranscodeReason:  "H.264 10-bit (Hi10P) not supported by browser MediaSource API; transcoding to 8-bit H.264",
			AudioTrackIndex:  -1,
			AudioNeedsRecode: !DirectPlayAudioCodecs[audioCodec],
			AudioPassthrough: DirectPlayAudioCodecs[audioCodec],
		}
	}
	// Treat empty audio codec as compatible (silent video files)
	audioOK := audioCodec == "" || DirectPlayAudioCodecs[audioCodec]
	if DirectPlayContainers[container] && DirectPlayCodecs[videoCodec] && audioOK {
		return PlaybackDecision{Decision: "direct_play", AudioTrackIndex: -1, AudioPassthrough: true}
	}
	if DirectPlayCodecs[videoCodec] {
		return PlaybackDecision{
			Decision:         "direct_stream",
			TranscodeReason:  "container requires remux",
			Remux:            true,
			AudioTrackIndex:  -1,
			AudioNeedsRecode: !audioOK,
			AudioPassthrough: audioOK,
		}
	}
	return PlaybackDecision{
		Decision:         "transcode",
		TranscodeReason:  "video codec requires transcoding",
		AudioTrackIndex:  -1,
		AudioNeedsRecode: !audioOK,
		AudioPassthrough: audioOK,
	}
}

// findBestAudioTrack evaluates all audio tracks and returns the best one the
// client can play. Preference: compatible default → any compatible → default → first.
//
// The isDefault return value indicates whether the chosen track is the one the
// browser would select automatically in direct play mode (the track marked
// default, or the first track if none is marked). When isDefault is false,
// direct play cannot select the right track — a remux with -map is required.
func findBestAudioTrack(tracks []models.AudioTrack, caps *ClientCaps) (index int, codec string, compatible bool, isDefault bool) {
	if len(tracks) == 0 {
		// No audio tracks = no audio incompatibility. Silent videos (dashcam
		// footage, GIF-to-MP4 conversions) should still qualify for direct play.
		return -1, "", true, true
	}

	// Check whether any track has an explicit default flag.
	// Many containers (especially MKV from mkvmerge) don't mark any track
	// as default. In that case, the browser auto-selects the first track,
	// so we treat track 0 as the effective default.
	hasExplicitDefault := false
	for _, t := range tracks {
		if t.IsDefault {
			hasExplicitDefault = true
			break
		}
	}

	// First pass: compatible default track (explicit or effective)
	for i, t := range tracks {
		tc := strings.ToLower(t.Codec)
		effectiveDefault := t.IsDefault || (!hasExplicitDefault && i == 0)
		if effectiveDefault && caps.AudioCodecs[tc] {
			return i, tc, true, true
		}
	}

	// Second pass: any compatible track (non-default)
	for i, t := range tracks {
		tc := strings.ToLower(t.Codec)
		if caps.AudioCodecs[tc] {
			return i, tc, true, false
		}
	}

	// No compatible track found; return the default or first
	for i, t := range tracks {
		if t.IsDefault {
			return i, strings.ToLower(t.Codec), false, true
		}
	}
	return 0, strings.ToLower(tracks[0].Codec), false, true
}

// ServeFile serves a media file with HTTP range request support (direct play path).
func ServeFile(w http.ResponseWriter, r *http.Request, filePath string) {
	f, err := os.Open(filePath)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		http.Error(w, "cannot stat file", http.StatusInternalServerError)
		return
	}

	contentType := "video/mp4"
	switch strings.ToLower(filepath.Ext(filePath)) {
	case ".mkv":
		contentType = "video/x-matroska"
	case ".webm":
		contentType = "video/webm"
	case ".mov":
		contentType = "video/quicktime"
	case ".avi":
		contentType = "video/x-msvideo"
	case ".ts":
		contentType = "video/mp2t"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, filepath.Base(filePath), stat.ModTime(), f)
}

// ============================================================
// Adaptive HLS Transcoding Engine
// ============================================================

// TranscodeManager manages multi-quality HLS transcode sessions.
//
// Lock ordering: tm.mu MUST be acquired before any session's variantMu.
// Never acquire tm.mu while holding a variantMu.
type TranscodeManager struct {
	mu              sync.Mutex
	sessions        map[string]*TranscodeSession
	baseDir         string
	hwAccel         HWAccelInfo
	cfg             config.TranscodeConfig
	enabledProfiles []string
	done            chan struct{}

	// OnSessionEvent is an optional callback invoked when transcode sessions
	// change state (created, stopped, expired). The callback receives an event
	// type string and a data payload suitable for WebSocket broadcast.
	// It is safe to leave nil; callers are guarded by a nil check.
	OnSessionEvent func(eventType string, data interface{})
}

// TranscodeSession tracks a user's adaptive streaming session for one media file.
type TranscodeSession struct {
	ID           string                     `json:"id"`
	UserID       int64                      `json:"user_id"`
	Username     string                     `json:"username"`
	FilePath     string                     `json:"-"`
	FileName     string                     `json:"file_name"`
	OutputDir    string                     `json:"-"`
	Profiles     []QualityProfile           `json:"profiles"`
	Variants     map[string]*QualityVariant `json:"-"`
	variantMu    sync.Mutex
	StartedAt    time.Time `json:"started_at"`
	LastAccess   time.Time `json:"last_access"`
	SourceWidth  int       `json:"source_width"`
	SourceHeight int       `json:"source_height"`
	// Subtitle burn-in config (optional)
	BurnSubIndex    int    `json:"burn_sub_index,omitempty"` // -1 = no burn-in
	BurnSubExternal string `json:"-"`                        // path to external sub file
	BurnSubBitmap   bool   `json:"burn_sub_bitmap,omitempty"`
	// HDR-to-SDR tonemapping: set when transcoding 10-bit HEVC HDR to 8-bit H.264
	HDRTonemap bool `json:"hdr_tonemap,omitempty"`
	// Bandwidth estimation: total bytes served for this session
	BytesServed int64 `json:"-"`
	// Remux mode: copy video codec, near-zero CPU (Phase 3 direct stream)
	Remux          bool `json:"remux,omitempty"`
	RemuxAudioCopy bool `json:"-"` // true = copy audio too, false = transcode audio to AAC
	// Audio passthrough: copy audio stream instead of re-encoding to AAC
	AudioPassthrough bool `json:"audio_passthrough,omitempty"`
	// Audio track selection: 0-based index for -map 0:a:N; -1 = FFmpeg default (first audio)
	AudioTrackIndex int `json:"-"`
	// Source audio channel count for bitrate scaling (0 = default to 2)
	AudioChannels int `json:"-"`
	// Source video codec for BSF selection in remux mode (e.g., "hevc" needs hevc_mp4toannexb)
	SourceVideoCodec string `json:"-"`
	// StartSec is the resume seek offset passed to FFmpeg via -ss. When > 0,
	// HLS segments start at ~this position in the source file. The frontend
	// must add this offset back when reporting playback progress.
	StartSec int `json:"start_sec,omitempty"`
	// HLS inline subtitle tracks: text-based subs extracted by the FFmpeg
	// pipeline as segmented WebVTT. Populated from SessionOpts.SubtitleTracks.
	SubtitleTracks []HLSSubtitleTrack `json:"-"`
	// subtitlesAttached is set to true once one variant's FFmpeg command has
	// been augmented with subtitle output chains. Prevents duplicate extraction
	// when multiple quality variants start (subtitle content is identical
	// regardless of video resolution).
	subtitlesAttached bool
	// initPTS90kHz caches the PTS (in 90kHz ticks) of the first PES packet
	// in the first .ts segment. Used for X-TIMESTAMP-MAP in WebVTT subtitle
	// segments to align cue times with the MPEG-TS PTS timeline. Lazily
	// populated on first subtitle segment request.
	// Values: -1 = not probed, -2 = probe in progress, >= 0 = cached PTS.
	initPTS90kHz int64
}

// QualityVariant is a single FFmpeg process transcoding at one quality level.
type QualityVariant struct {
	Profile   QualityProfile
	OutputDir string
	Cmd       *exec.Cmd
	Cancel    context.CancelFunc
	Ready     chan struct{}
	Err       error
	started   bool
	// exited is set by the cmd.Wait goroutine when ffmpeg returns. The
	// playback/poll paths read it (via ffmpegDone) to fail fast instead of
	// spinning a long retry budget on a process that's already dead.
	exited bool
	// restartAttempts counts how many times we've tried to recover this
	// variant from a mid-stream FFmpeg crash. Capped at variantRestartMax
	// to prevent infinite restart loops on a permanently-broken source.
	// 2026-05-16 P3 — auto-recovery for transient FFmpeg failures (OOM,
	// codec hiccup, source I/O glitch). See EnsureVariant.
	restartAttempts int
}

// variantRestartMax is the max number of in-place FFmpeg restarts we'll
// attempt for a single variant. After this, the variant is considered
// permanently dead and the frontend must create a fresh session. One
// restart covers the common case (transient resource pressure); more
// attempts would mask a real underlying issue.
const variantRestartMax = 1

// ffmpegDone reports whether the variant's ffmpeg process has terminated.
// Two signals: our own `exited` flag (set by the cmd.Wait goroutine on
// normal exit) and Cmd.ProcessState (set by exec.Cmd after Wait returns).
// Either being non-nil/true means we should stop waiting for outputs.
func ffmpegDone(v *QualityVariant) bool {
	if v == nil {
		return false
	}
	if v.exited {
		return true
	}
	if v.Cmd != nil && v.Cmd.ProcessState != nil {
		return true
	}
	return false
}

// SessionInfo is the public API response for a session.
type SessionInfo struct {
	ID               string           `json:"id"`
	UserID           int64            `json:"user_id"`
	Username         string           `json:"username"`
	FileName         string           `json:"file_name"`
	SourceWidth      int              `json:"source_width"`
	SourceHeight     int              `json:"source_height"`
	Profiles         []QualityProfile `json:"profiles"`
	MasterPlaylist   string           `json:"master_playlist_url"`
	StartedAt        time.Time        `json:"started_at"`
	ActiveVariants   []string         `json:"active_variants"`
	Remux            bool             `json:"remux"`
	AudioPassthrough bool             `json:"audio_passthrough"`
	// Resource tracking (Feature 3)
	Resources *SessionResources `json:"resources,omitempty"`
}

// SessionResources tracks CPU and memory usage for a transcode session's FFmpeg processes.
type SessionResources struct {
	CPUTicks     float64 `json:"cpu_ticks"`     // Accumulated CPU clock ticks (utime+stime) across variants
	MemoryBytes  int64   `json:"memory_bytes"`  // Aggregate RSS across all active variants
	NumProcesses int     `json:"num_processes"` // Number of active FFmpeg processes
	BandwidthBps float64 `json:"bandwidth_bps"` // Estimated bytes per second served
}

// NewTranscodeManager creates the adaptive transcode manager.
func NewTranscodeManager(baseDir string, tcCfg config.TranscodeConfig) (*TranscodeManager, error) {
	if err := os.MkdirAll(baseDir, 0o750); err != nil {
		return nil, fmt.Errorf("create transcode dir: %w", err)
	}

	hwAccel := DetectHWAccel(tcCfg.HWAccel)

	tm := &TranscodeManager{
		sessions:        make(map[string]*TranscodeSession),
		baseDir:         baseDir,
		hwAccel:         hwAccel,
		cfg:             tcCfg,
		enabledProfiles: tcCfg.Profiles,
		done:            make(chan struct{}),
	}

	go tm.cleanupLoop()

	slog.Info("transcode manager ready",
		"hw_accel", hwAccel.DisplayName,
		"max_sessions", tcCfg.MaxSessions,
		"profiles", tcCfg.Profiles,
	)

	return tm, nil
}

// SetMaxSessions updates the maximum concurrent transcode sessions at runtime.
// This is called by the admin API when the transcode_max_sessions setting changes,
// allowing hot-reload without restarting the server.
func (tm *TranscodeManager) SetMaxSessions(n int) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	tm.cfg.MaxSessions = n
	slog.Info("transcode max sessions updated", "max_sessions", n)
}

// HWAccelStatus returns info about the detected hardware acceleration.
func (tm *TranscodeManager) HWAccelStatus() HWAccelInfo {
	return tm.hwAccel
}

// Close shuts down the cleanup goroutine. Call this during graceful shutdown.
func (tm *TranscodeManager) Close() {
	close(tm.done)
}

func (tm *TranscodeManager) cleanupLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
		case <-tm.done:
			return
		}
		timeout := tm.cfg.SessionTimeout
		if timeout == 0 {
			timeout = 5 * time.Minute
		}

		// Phase 1: identify and remove expired sessions under lock (fast)
		var expired []*TranscodeSession
		tm.mu.Lock()
		for id, s := range tm.sessions {
			if time.Since(s.LastAccess) > timeout {
				slog.Info("cleaning up idle transcode session", "session_id", id, "user_id", s.UserID)
				delete(tm.sessions, id)
				expired = append(expired, s)
			}
		}
		tm.mu.Unlock()

		// Phase 2: stop processes and delete files WITHOUT holding the main lock.
		// This prevents os.RemoveAll on large segment dirs from blocking
		// all session operations (create, get, keepalive).
		for _, s := range expired {
			// Fire session event callback for expired sessions
			if tm.OnSessionEvent != nil {
				tm.OnSessionEvent("expired", map[string]interface{}{
					"session_id": s.ID,
					"user_id":    s.UserID,
					"username":   s.Username,
					"file_name":  s.FileName,
					"status":     "expired",
					"profile":    tm.primaryProfileName(s),
				})
			}

			s.variantMu.Lock()
			for _, v := range s.Variants {
				if v.Cancel != nil {
					v.Cancel()
				}
			}
			s.variantMu.Unlock()
			os.RemoveAll(s.OutputDir)
		}
	}
}

// ============================================================
// Session Lifecycle
// ============================================================

// BurnInOpts configures subtitle burn-in for a transcode session.
type BurnInOpts struct {
	SubIndex     int    // Embedded subtitle stream index (-1 or unused = none)
	ExternalPath string // Path to external subtitle file (empty = none)
	IsBitmap     bool   // True for PGS/VOBSUB bitmap subs
}

// HLSSubtitleTrack carries the info needed to add a subtitle output chain
// to the FFmpeg command in startVariant. Only text-based subtitle tracks
// (subrip, ass, ssa, mov_text, webvtt) should be included — bitmap formats
// (PGS, VOBSUB, DVB) cannot be converted to WebVTT.
type HLSSubtitleTrack struct {
	AbsoluteIndex int    // FFprobe absolute stream index (for -map 0:N)
	Language      string // ISO 639 language code (e.g., "eng", "spa")
	Title         string // Track title (e.g., "English SDH")
	Forced        bool   // Forced subtitle flag
	Default       bool   // Default subtitle flag
}

// SessionOpts configures optional behavior for a transcode session.
type SessionOpts struct {
	BurnIn           *BurnInOpts
	Remux            bool   // true = copy video codec (direct stream), near-zero CPU
	RemuxAudioCopy   bool   // true = also copy audio (only valid when Remux=true and audio is browser-compatible)
	AudioPassthrough bool   // true = copy audio stream instead of re-encoding (full transcode mode)
	AudioTrackIndex  int    // 0-based audio track to select via -map; -1 = FFmpeg default
	AudioChannels    int    // source audio channel count for bitrate scaling (0 = default to 2)
	HDRTonemap       bool   // true = inject HDR-to-SDR tonemapping filters (10-bit HEVC → 8-bit H.264)
	SourceVideoCodec string // source video codec (e.g., "hevc", "h264") for BSF selection in remux mode
	StartSec         int    // resume position: FFmpeg -ss seek offset in seconds (0 = start from beginning)
	// SubtitleTracks lists text-based subtitle tracks to extract inline via
	// the HLS pipeline. Each track gets its own WebVTT segmented output chain
	// appended to the FFmpeg command, piggybacking on the same file I/O as
	// the video/audio transcode — zero extra disk reads.
	SubtitleTracks []HLSSubtitleTrack
}

// CreateSession creates a new adaptive transcode session for a media file.
func (tm *TranscodeManager) CreateSession(userID int64, username string, filePath string, sourceWidth, sourceHeight int, opts ...SessionOpts) (*TranscodeSession, error) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return nil, fmt.Errorf("ffmpeg not found in PATH")
	}

	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, fmt.Errorf("generate session id: %w", err)
	}
	sessionID := hex.EncodeToString(idBytes)

	outputDir := filepath.Join(tm.baseDir, sessionID)
	if err := os.MkdirAll(outputDir, 0o750); err != nil {
		return nil, fmt.Errorf("create session dir: %w", err)
	}

	profiles := ResolveProfiles(tm.enabledProfiles, sourceWidth, sourceHeight)

	// In remux mode, we only need one "profile" at the source resolution
	// since codec copy can't change resolution
	if len(opts) > 0 && opts[0].Remux {
		profiles = []QualityProfile{{
			Name:         "source",
			Width:        sourceWidth,
			Height:       sourceHeight,
			HLSBandwidth: 20000000, // Conservative bandwidth hint for remux
		}}
	}

	// Reject sessions with no viable profiles. Without this guard, every
	// EnsureVariant call would return "unknown profile" forever and the
	// session would sit in tm.sessions wasting a slot until idle timeout —
	// with ActiveVariants=0 it's invisible in admin diagnostics. Common
	// trigger: a very-low-resolution source with all enabled profiles
	// requiring a higher MinHeight.
	if len(profiles) == 0 {
		os.RemoveAll(outputDir)
		return nil, fmt.Errorf("no quality profiles resolved for source %dx%d (check enabled profiles' min_height)", sourceWidth, sourceHeight)
	}

	session := &TranscodeSession{
		ID:              sessionID,
		UserID:          userID,
		Username:        username,
		FilePath:        filePath,
		FileName:        filepath.Base(filePath),
		OutputDir:       outputDir,
		Profiles:        profiles,
		Variants:        make(map[string]*QualityVariant),
		StartedAt:       time.Now(),
		LastAccess:      time.Now(),
		SourceWidth:     sourceWidth,
		SourceHeight:    sourceHeight,
		BurnSubIndex:    -1,
		AudioTrackIndex: -1,
		initPTS90kHz:    -1, // not yet probed
	}

	// Apply session options if provided
	if len(opts) > 0 {
		o := opts[0]
		if o.BurnIn != nil {
			session.BurnSubIndex = o.BurnIn.SubIndex
			session.BurnSubExternal = o.BurnIn.ExternalPath
			session.BurnSubBitmap = o.BurnIn.IsBitmap
		}
		session.Remux = o.Remux
		session.RemuxAudioCopy = o.RemuxAudioCopy
		session.AudioPassthrough = o.AudioPassthrough
		session.AudioTrackIndex = o.AudioTrackIndex
		session.AudioChannels = o.AudioChannels
		session.HDRTonemap = o.HDRTonemap
		session.SourceVideoCodec = strings.ToLower(o.SourceVideoCodec)
		session.StartSec = o.StartSec
		session.SubtitleTracks = o.SubtitleTracks
	}

	// Set HLS CODECS string on profiles for the master playlist.
	// Transcode: H.264 Baseline + AAC-LC. The H.264 level varies by resolution
	// to comply with the spec: 1080p needs Level 4.0+, 720p needs Level 3.1.
	// Remux: codec string is unknown at creation time (omitted, valid per HLS spec).
	if !session.Remux {
		for i := range profiles {
			profiles[i].CodecString = hlsCodecString(profiles[i].Height)
		}
		session.Profiles = profiles
	}

	for _, p := range profiles {
		varDir := filepath.Join(outputDir, p.Name)
		if err := os.MkdirAll(varDir, 0o750); err != nil {
			os.RemoveAll(outputDir)
			return nil, fmt.Errorf("create variant dir %s: %w", p.Name, err)
		}
		session.Variants[p.Name] = &QualityVariant{
			Profile:   p,
			OutputDir: varDir,
			Ready:     make(chan struct{}),
		}
	}

	// Atomic check-and-insert under one lock hold to prevent TOCTOU race
	// on the max sessions limit. All I/O (mkdir, rand) is done above so
	// the critical section is short.
	tm.mu.Lock()
	if tm.cfg.MaxSessions > 0 && len(tm.sessions) >= tm.cfg.MaxSessions {
		tm.mu.Unlock()
		os.RemoveAll(outputDir) // Clean up pre-created dirs
		return nil, fmt.Errorf("maximum transcode sessions reached (%d)", tm.cfg.MaxSessions)
	}
	tm.sessions[sessionID] = session
	tm.mu.Unlock()

	slog.Info("transcode session created",
		"session_id", sessionID,
		"user_id", userID,
		"file", filepath.Base(filePath),
		"profiles", len(profiles),
		"source", fmt.Sprintf("%dx%d", sourceWidth, sourceHeight),
	)

	// Fire session event callback for admin dashboard notifications
	if tm.OnSessionEvent != nil {
		profileName := ""
		if len(profiles) > 0 {
			profileName = profiles[0].Name
		}
		tm.OnSessionEvent("started", map[string]interface{}{
			"session_id": sessionID,
			"user_id":    userID,
			"username":   username,
			"file_name":  session.FileName,
			"status":     "started",
			"profile":    profileName,
		})
	}

	return session, nil
}

// GetSession retrieves a session by ID and refreshes its keepalive.
func (tm *TranscodeManager) GetSession(sessionID string) (*TranscodeSession, bool) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	s, ok := tm.sessions[sessionID]
	if ok {
		s.LastAccess = time.Now()
	}
	return s, ok
}

// KeepAlive refreshes a session's last access time.
func (tm *TranscodeManager) KeepAlive(sessionID string) bool {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	s, ok := tm.sessions[sessionID]
	if ok {
		s.LastAccess = time.Now()
	}
	return ok
}

// GetSessionOwner returns the user ID of a session's owner, or -1 if not found.
func (tm *TranscodeManager) GetSessionOwner(sessionID string) int64 {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	s, ok := tm.sessions[sessionID]
	if !ok {
		return -1
	}
	return s.UserID
}

// StopSession stops and cleans up a transcode session.
// Uses two-phase cleanup: remove from map under lock (fast), then stop
// processes and delete files without the lock to avoid blocking other
// session operations during potentially slow os.RemoveAll I/O.
func (tm *TranscodeManager) StopSession(sessionID string) {
	tm.mu.Lock()
	s, ok := tm.sessions[sessionID]
	if ok {
		delete(tm.sessions, sessionID)
	}
	tm.mu.Unlock()

	if ok {
		// Fire session event callback before cleanup
		if tm.OnSessionEvent != nil {
			tm.OnSessionEvent("stopped", map[string]interface{}{
				"session_id": sessionID,
				"user_id":    s.UserID,
				"username":   s.Username,
				"file_name":  s.FileName,
				"status":     "stopped",
				"profile":    tm.primaryProfileName(s),
			})
		}

		s.variantMu.Lock()
		for _, v := range s.Variants {
			if v.Cancel != nil {
				v.Cancel()
			}
		}
		s.variantMu.Unlock()
		os.RemoveAll(s.OutputDir)
	}
}

// StopAllSessions cleans up all sessions (for graceful shutdown).
func (tm *TranscodeManager) StopAllSessions() {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	for id, s := range tm.sessions {
		tm.stopSessionLocked(s)
		delete(tm.sessions, id)
	}
}

func (tm *TranscodeManager) stopSessionLocked(s *TranscodeSession) {
	s.variantMu.Lock()
	defer s.variantMu.Unlock()
	for _, v := range s.Variants {
		if v.Cancel != nil {
			v.Cancel()
		}
	}
	os.RemoveAll(s.OutputDir)
}

// ListSessions returns info about all active sessions (for admin API).
func (tm *TranscodeManager) ListSessions() []SessionInfo {
	type sessionSnapshot struct {
		session     *TranscodeSession
		info        SessionInfo
		pids        []int
		bytesServed int64
		startedAt   time.Time
	}

	// Phase 1: snapshot session pointers and immutable data under tm.mu (fast, no I/O).
	// We do NOT lock variantMu here to avoid holding both locks simultaneously.
	tm.mu.Lock()
	snapshots := make([]sessionSnapshot, 0, len(tm.sessions))
	for _, s := range tm.sessions {
		snap := sessionSnapshot{
			session:     s,
			bytesServed: atomic.LoadInt64(&s.BytesServed),
			startedAt:   s.StartedAt,
			info: SessionInfo{
				ID:               s.ID,
				UserID:           s.UserID,
				Username:         s.Username,
				FileName:         s.FileName,
				SourceWidth:      s.SourceWidth,
				SourceHeight:     s.SourceHeight,
				Profiles:         s.Profiles,
				MasterPlaylist:   fmt.Sprintf("/api/stream/hls/%s/master.m3u8", s.ID),
				StartedAt:        s.StartedAt,
				Remux:            s.Remux,
				AudioPassthrough: s.AudioPassthrough,
			},
		}
		snapshots = append(snapshots, snap)
	}
	tm.mu.Unlock()

	// Phase 2: collect variant info under per-session variantMu (tm.mu is NOT held)
	for i := range snapshots {
		s := snapshots[i].session
		s.variantMu.Lock()
		for name, v := range s.Variants {
			if v.started {
				snapshots[i].info.ActiveVariants = append(snapshots[i].info.ActiveVariants, name)
				if v.Cmd != nil && v.Cmd.Process != nil {
					snapshots[i].pids = append(snapshots[i].pids, v.Cmd.Process.Pid)
				}
			}
		}
		s.variantMu.Unlock()
	}

	// Phase 3: collect /proc resource data WITHOUT holding any locks
	result := make([]SessionInfo, len(snapshots))
	for i, snap := range snapshots {
		result[i] = snap.info
		if len(snap.pids) > 0 {
			result[i].Resources = collectProcessResources(snap.pids)
		}
		// Compute bandwidth: bytes served / seconds since start
		elapsed := time.Since(snap.startedAt).Seconds()
		if elapsed > 0 && snap.bytesServed > 0 {
			bw := float64(snap.bytesServed) / elapsed
			if result[i].Resources == nil {
				result[i].Resources = &SessionResources{}
			}
			result[i].Resources.BandwidthBps = bw
		}
	}
	return result
}

// ActiveSessions returns the count of active transcode sessions.
func (tm *TranscodeManager) ActiveSessions() int {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return len(tm.sessions)
}

// ============================================================
// On-Demand Quality Variant Startup
// ============================================================

// EnsureVariant starts the FFmpeg process for a quality level on first access.
//
// 2026-05-16 P3 — auto-recovery: if a previously-started variant is found
// dead (FFmpeg crashed mid-stream), we attempt an in-place restart up to
// variantRestartMax times. The restart resumes from the next segment
// number after the highest one already on disk, so HLS.js's continuing
// playlist polls see seamless continuation rather than a permanent 500.
// On exceeding the cap, the typed "variant ended" error is returned and
// the frontend must create a fresh session.
func (tm *TranscodeManager) EnsureVariant(session *TranscodeSession, profileName string, startSec int) (*QualityVariant, error) {
	session.variantMu.Lock()
	defer session.variantMu.Unlock()

	v, ok := session.Variants[profileName]
	if !ok {
		return nil, fmt.Errorf("unknown profile: %s", profileName)
	}

	if v.started {
		// If ffmpeg died after Ready was closed (segments started flowing,
		// then OOM-kill / signal / disk full mid-stream), the variant is
		// dead but `started` stayed true. Without this check, EnsureVariant
		// would return a zombie variant forever and segment requests would
		// 404 with no actionable signal.
		if ffmpegDone(v) {
			// P3 — attempt one in-place restart before surfacing the
			// "session is dead" error. Originally remux sessions were
			// excluded (concern: codec-copy seek to a non-keyframe
			// boundary produces a discontinuity). Walked that back on
			// 2026-05-16 because the actual failure mode (SSHFS-mounted
			// source dropping I/O → FFmpeg dies on remux) was leaving
			// remux users with 60-second broken states. The cost of
			// restarting remux: a 0-2s rewind at the resume boundary
			// (FFmpeg's `-ss` snaps to the nearest preceding keyframe
			// in the source). The cost of NOT restarting: permanent
			// session death until the frontend's P2 recovery kicks in,
			// or the user manually closes. Wrong trade-off the first
			// time — fixed now.
			if v.restartAttempts < variantRestartMax {
				v.restartAttempts++
				highestSeg := highestSegmentNumber(v.OutputDir)
				// Audit M3 — subtitles freeze at the crash point on
				// restart. The original FFmpeg process produced both
				// video and subtitle outputs in one invocation; on
				// restart we re-launch ONLY the video/audio chain
				// because session.subtitlesAttached is true and the
				// subtitle output is wired by that flag at line ~1485.
				// Re-attaching subtitles would require resetting
				// -segment_start_number and tracking sub seg counters
				// separately — out of scope for the recovery
				// shortcut. Acceptable trade-off: viewer sees
				// continuous video, subtitles end at the crash point.
				// Operators see a Warn log so the limitation is
				// visible in production.
				slog.Warn("variant FFmpeg crashed mid-stream, attempting auto-restart",
					"session_id", session.ID,
					"profile", profileName,
					"attempt", v.restartAttempts,
					"highest_segment", highestSeg,
					"subtitles_freeze_at_crash", len(session.SubtitleTracks) > 0,
					"prev_err", v.Err,
				)
				// Compute resume source-second: source was at
				// startSec + (highestSeg + 1) * segDuration when crash
				// occurred. New FFmpeg seeks there and continues writing
				// from seg_{highestSeg+1}.
				segDur := tm.cfg.SegmentDuration
				if segDur <= 0 {
					segDur = 6 // matches the fallback in startVariantImpl
				}
				resumeFromSec := startSec
				resumeSegNum := 0
				if highestSeg >= 0 {
					resumeSegNum = highestSeg + 1
					resumeFromSec = startSec + resumeSegNum*segDur
				}
				// Reset variant state for fresh startVariant. The Ready
				// channel must be a fresh chan because the prior one was
				// closed; reading from a closed chan never blocks so
				// readers would see "ready" immediately on the stale chan.
				v.Ready = make(chan struct{})
				v.started = false
				v.exited = false
				v.Err = nil
				v.Cmd = nil
				if err := tm.startVariantAt(session, v, resumeFromSec, resumeSegNum); err != nil {
					// Restart failed — fall back to surfacing the original
					// crash error to the caller. The restartAttempts bump
					// above ensures we don't infinite-retry.
					return nil, fmt.Errorf("variant %s restart failed: %w", profileName, err)
				}
				return v, nil
			}
			// No more restart budget — return the typed error so the
			// caller (or frontend) can recover via StopSession + new
			// session creation. The error includes the FFmpeg stderr
			// tail (P1) so logs show WHY it died.
			err := v.Err
			if err == nil {
				err = fmt.Errorf("ffmpeg exited unexpectedly")
			}
			return nil, fmt.Errorf("variant %s ended: %w", profileName, err)
		}
		return v, nil
	}

	if err := tm.startVariant(session, v, startSec); err != nil {
		return nil, err
	}

	return v, nil
}

// highestSegmentNumber walks the variant output directory and returns the
// highest COMPLETE seg_NNNNN.ts number written, or -1 if none. Used by
// the P3 auto-restart path to compute where to resume FFmpeg's output.
// Bounded O(N) on directory size; N is the segment count of the session-
// so-far which is small (a 2-hour movie at 6s segments is ~1200 entries).
//
// Audit H2 fix: filter out zero-byte / undersized files. If FFmpeg
// crashed mid-write of seg_N.ts, the file exists but is truncated.
// Returning N would cause the restart to set start_number=N+1, but
// the playlist would still reference the truncated seg_N.ts and HLS.js
// would fetch a corrupt TS and fail. Skip anything under
// minSegmentSizeBytes — for an MPEG-TS container, even an empty audio-
// only frame fills at least a few packets (~10KB). 4KB is a safe floor
// that filters zero-byte writes without false-positives on the final
// segment of a short transcode.
const minSegmentSizeBytes = 4096

func highestSegmentNumber(varDir string) int {
	// 2026-05-19 audit (BE-H5) — prefer the playlist as the source of
	// truth for "what's a complete segment." FFmpeg writes the .m3u8
	// only AFTER finishing each segment, so any segment number that
	// appears in playlist.m3u8 was emitted intact. This handles the
	// edge case of a legitimately small final segment (e.g. an EOF
	// audio frame producing a 2 KB segment) that the size-heuristic
	// path below would discard, leading to overwrite on restart.
	if n := playlistHighestSegmentNumber(filepath.Join(varDir, "playlist.m3u8")); n >= 0 {
		return n
	}

	entries, err := os.ReadDir(varDir)
	if err != nil {
		return -1
	}
	highest := -1
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		if !strings.HasPrefix(name, "seg_") || !strings.HasSuffix(name, ".ts") {
			continue
		}
		numStr := strings.TrimSuffix(strings.TrimPrefix(name, "seg_"), ".ts")
		n, convErr := strconv.Atoi(numStr)
		if convErr != nil {
			continue
		}
		info, infoErr := ent.Info()
		if infoErr != nil {
			continue
		}
		if info.Size() < minSegmentSizeBytes {
			// Likely the partial write FFmpeg was working on when it
			// crashed. Don't count it as the resume anchor — the next
			// FFmpeg will overwrite this file at the same seg_N
			// position (the playlist's append_list will still see the
			// PREVIOUS segment as the last entry, so HLS.js won't have
			// referenced this partial one).
			continue
		}
		if n > highest {
			highest = n
		}
	}
	return highest
}

// playlistHighestSegmentNumber returns the highest seg_N.ts number
// referenced by the given HLS playlist, or -1 if the playlist doesn't
// exist or is empty. FFmpeg appends to the playlist only after a
// segment is fully written, so anything in here is guaranteed complete
// regardless of its on-disk size.
//
// 2026-05-19 audit (BE-H5) — added to defend against the edge case
// where a final segment is legitimately smaller than minSegmentSizeBytes.
func playlistHighestSegmentNumber(playlistPath string) int {
	data, err := os.ReadFile(playlistPath)
	if err != nil {
		return -1
	}
	highest := -1
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "seg_") || !strings.HasSuffix(line, ".ts") {
			continue
		}
		numStr := strings.TrimSuffix(strings.TrimPrefix(line, "seg_"), ".ts")
		n, convErr := strconv.Atoi(numStr)
		if convErr != nil {
			continue
		}
		if n > highest {
			highest = n
		}
	}
	return highest
}

// hlsCodecString returns the HLS CODECS attribute string for a given output height.
// Format: avc1.PPCCLL where PP=profile_idc, CC=constraint_set flags, LL=level_idc in hex.
// Paired with AAC-LC (mp4a.40.2).
//
// Profile selection must match h264Profile() in hwaccel.go:
//   - Above 1080p: High profile (64=0x64) — enables B-frames + CABAC for 4K quality
//   - 1080p and below: Baseline profile (42=0x42) — maximum device compatibility
func hlsCodecString(height int) string {
	// Level selection per H.264 Annex A:
	//   Level 3.0 (1e): up to 480p (40,500 MB/s)
	//   Level 3.1 (1f): up to 720p (108,000 MB/s)
	//   Level 4.0 (28): up to 1080p (245,760 MB/s)
	//   Level 5.1 (33): up to 2160p
	var level string
	switch {
	case height > 1080:
		level = "33" // Level 5.1 for 4K
	case height > 720:
		level = "28" // Level 4.0 for 1080p
	case height > 480:
		level = "1f" // Level 3.1 for 720p
	default:
		level = "1e" // Level 3.0 for 480p and below
	}

	// High profile (6400) for 4K, Baseline (4200) for everything else
	if height > 1080 {
		return fmt.Sprintf("avc1.6400%s,mp4a.40.2", level)
	}
	return fmt.Sprintf("avc1.4200%s,mp4a.40.2", level)
}

// audioBitrate returns an appropriate AAC bitrate string scaled by channel
// count: 64 kbps per channel, minimum 128 k (stereo). Stays callable for
// tests and future transcode tuning; currently the HLS pipeline hardcodes
// 192 k for HLS.js TS demuxer compatibility so this isn't on the hot path.
func audioBitrate(channels int) string {
	if channels <= 0 {
		channels = 2
	}
	bps := channels * 64
	if bps < 128 {
		bps = 128
	}
	return fmt.Sprintf("%dk", bps)
}

// startVariant launches FFmpeg for a single profile. resumeSegNum=0 is the
// normal fresh-start case. resumeSegNum>0 is the P3 auto-restart path:
// FFmpeg is started with -start_number set so output segment numbering
// continues from where the prior (crashed) process left off, giving HLS.js
// seamless playlist continuation. Compatibility shim startVariantAt below
// is a thin wrapper retained for call-site clarity.
func (tm *TranscodeManager) startVariantAt(session *TranscodeSession, v *QualityVariant, startSec, resumeSegNum int) error {
	return tm.startVariantImpl(session, v, startSec, resumeSegNum)
}

func (tm *TranscodeManager) startVariant(session *TranscodeSession, v *QualityVariant, startSec int) error {
	return tm.startVariantImpl(session, v, startSec, 0)
}

func (tm *TranscodeManager) startVariantImpl(session *TranscodeSession, v *QualityVariant, startSec, resumeSegNum int) error {
	p := v.Profile
	playlistPath := filepath.Join(v.OutputDir, "stream.m3u8")
	segmentPath := filepath.Join(v.OutputDir, "seg_%05d.ts")

	ctx, cancel := context.WithCancel(context.Background())
	v.Cancel = cancel

	segDuration := tm.cfg.SegmentDuration
	if segDuration <= 0 {
		segDuration = 6
	}

	// Timestamp handling differs between remux and full transcode:
	//
	// Remux (video copy): the copied video retains its original MKV timestamps.
	// Using -fflags +genpts would generate FRESH PTS for the transcoded audio
	// that clash with the video's original timestamps in the TS muxer, causing
	// HLS.js to stretch audio playback (deep/slow sound). Instead, -copyts
	// preserves the original A/V timing relationship, and -start_at_zero
	// shifts everything so the first PTS is 0.
	//
	// Full transcode: both video and audio get fresh timestamps from their
	// encoders, so genpts is safe and helps normalise any gaps.
	var args []string
	if session.Remux {
		// Emby-style: -copyts preserves original A/V timing, -start_at_zero
		// shifts so PTS starts at 0, -avoid_negative_ts disabled prevents
		// FFmpeg from adding any PTS offset to "fix" negative timestamps.
		// Without -avoid_negative_ts disabled, the mpegts muxer (used by
		// both -f hls and -f segment) adds ~1.4s initial PTS offset, which
		// desynchronizes subtitle cue times from the video PTS timeline.
		args = []string{"-copyts", "-start_at_zero", "-avoid_negative_ts", "disabled"}
	} else {
		args = []string{
			"-fflags", "+genpts+discardcorrupt",
			"-avoid_negative_ts", "make_zero",
		}
	}
	if startSec > 0 {
		args = append(args, "-ss", strconv.Itoa(startSec))
	}

	args = append(args, "-i", session.FilePath)

	// Output muxer option: increase interleave queue for container remux
	// where video (copy) and audio (transcode) produce packets at different rates.
	args = append(args, "-max_muxing_queue_size", "2048")

	// Stream mapping: ALWAYS select explicit video + audio streams to exclude
	// subtitle, attachment, and data streams that cannot be muxed into .ts
	// segments. MKV files commonly contain ASS/SRT subtitles, embedded fonts
	// (as attachments), and chapter data — FFmpeg's default stream selection
	// includes ALL of these, causing "muxer does not support codec" errors
	// or producing broken .ts segments that HLS.js can't parse.
	//
	// -map 0:v:0 = first video stream
	// -map 0:a:N = Nth audio stream (0-based within audio streams)
	if session.AudioTrackIndex >= 0 {
		args = append(args, "-map", "0:v:0", "-map", fmt.Sprintf("0:a:%d", session.AudioTrackIndex))
	} else {
		// AudioTrackIndex -1 means "use default/first audio track". We still
		// need explicit -map to exclude subtitles and attachments from .ts output.
		// The trailing '?' makes the audio map optional — FFmpeg silently skips
		// it if the file has no audio streams (e.g., silent dashcam footage),
		// instead of failing with "Stream map '0:a:0' matches no streams."
		args = append(args, "-map", "0:v:0", "-map", "0:a:0?")
	}

	if session.Remux {
		// ── Remux mode: copy codecs, near-zero CPU ──
		args = append(args, "-c:v", "copy")

		// Bitstream filters for MKV/MP4 → MPEG-TS remux:
		// MKV/MP4 store NAL units in length-prefixed (AVCC/HVCC) format,
		// but MPEG-TS requires Annex B (start codes). FFmpeg's mpegts muxer
		// usually handles h264 conversion automatically, but some h264
		// streams (e.g., high-bitrate Blu-ray remuxes with MBAFF or complex
		// reference structures) produce .ts segments that macOS VideoToolbox
		// rejects with VTDecompressionOutputCallback error -12909. Explicit
		// h264_mp4toannexb ensures clean NAL unit conversion for all h264
		// sources, matching what Plex/Emby/Jellyfin do.
		svc := session.SourceVideoCodec
		if svc == "h264" || svc == "avc" || svc == "avc1" {
			args = append(args, "-bsf:v", "h264_mp4toannexb")
		} else if svc == "hevc" || svc == "h265" {
			args = append(args, "-bsf:v", "hevc_mp4toannexb")
		}

		if session.RemuxAudioCopy {
			args = append(args, "-c:a", "copy")
		} else {
			// Audio needs transcoding (e.g., EAC3/DTS/TrueHD → AAC for browser).
			// Force stereo downmix (-ac 2) for HLS .ts output: HLS.js's TS demuxer
			// remuxes audio into fMP4 for MediaSource, and multichannel AAC (5.1/7.1)
			// in .ts segments causes "audio SourceBuffer error" in Chrome because the
			// ADTS-to-fMP4 conversion produces an AudioSpecificConfig that Chrome's
			// MSE implementation rejects. Stereo AAC is universally supported.
			// Explicit -ar 48000 prevents sample-rate mismatch that causes
			// deep/slow audio when EAC3 48kHz is transcoded to AAC without a
			// declared output rate.
			args = append(args,
				"-c:a", "aac",
				"-ac", "2",
				"-ar", "48000",
				"-b:a", "192k",
			)
		}
	} else {
		// ── Full transcode mode ──
		// Video encoder (hardware-accelerated or software)
		encoderArgs := tm.hwAccel.VideoEncoderArgs(p.Width, p.Height)

		// HDR-to-SDR tonemapping: inject before subtitle burn-in so tonemap
		// operates on the raw decoded frames, then subtitles overlay the SDR output.
		if session.HDRTonemap {
			encoderArgs = injectTonemapFilter(encoderArgs, p.Width, p.Height)
		}

		// Inject subtitle burn-in into the filter chain if configured
		if session.BurnSubIndex >= 0 || session.BurnSubExternal != "" {
			encoderArgs = injectBurnInFilter(encoderArgs, session)
		}

		args = append(args, encoderArgs...)

		// Bitrate control
		if tm.hwAccel.Type == HWAccelNone {
			args = append(args, "-crf", strconv.Itoa(p.CRF))
		} else {
			args = append(args, "-b:v", p.VideoBitrate)
		}
		args = append(args, "-maxrate", p.MaxRate, "-bufsize", p.BufSize)

		// Audio
		if session.AudioPassthrough {
			args = append(args, "-c:a", "copy")
		} else {
			// Transcode audio to AAC with stereo downmix for HLS .ts output.
			// HLS.js's TS-to-fMP4 remuxer produces AudioSpecificConfig that
			// Chrome's MSE rejects for multichannel (5.1/7.1) AAC in .ts.
			// Explicit -ar 48000 prevents sample-rate mismatch causing
			// deep/slow audio playback.
			args = append(args,
				"-c:a", "aac",
				"-ac", "2",
				"-ar", "48000",
				"-b:a", "192k",
			)
		}
	}

	// HLS output.
	//
	// -muxdelay 0 -muxpreload 0: Eliminates the ~1.4s initial PTS offset
	// that the mpegts muxer adds by default (muxdelay=0.7s + muxpreload=0.5s).
	// Without these, video/audio PTS in .ts segments starts at ~1.4s even
	// with -start_at_zero, because the mpegts muxer adds its own offset
	// AFTER the demuxer/filter chain normalizes timestamps. This PTS offset
	// caused subtitle desync: X-TIMESTAMP-MAP had to compensate via probed
	// initPTS, and any mismatch (race condition, rounding) shifted subtitles.
	// With PTS starting at ~0, the subtitle cue times (preserved by -copyts)
	// map directly to the video timeline with no offset needed.
	//
	// -hls_playlist_type event: tells HLS.js this is an EVENT playlist where
	// segments are only appended (never removed). Without this, the playlist
	// has no EXT-X-PLAYLIST-TYPE tag, causing HLS.js to treat it as a live
	// stream with aggressive live-edge seeking and short timeouts — which
	// causes spurious errors during remux when FFmpeg is still producing
	// segments on the fly.
	// 2026-05-16 P3 + audit H3 — on auto-restart from a mid-stream FFmpeg
	// crash, FFmpeg needs to APPEND new entries to the existing stream.m3u8
	// rather than overwriting it. Without +append_list, the new playlist
	// would start fresh with #EXT-X-MEDIA-SEQUENCE:resumeSegNum, dropping
	// the pre-crash segments from the playlist window and violating
	// HLS.js's EVENT-playlist append-only contract. With +append_list,
	// FFmpeg reads the prior playlist, strips its EXT-X-ENDLIST if any,
	// and appends new segments — HLS.js sees a continuous, monotonic
	// segment list across the crash boundary.
	hlsFlags := "independent_segments"
	if resumeSegNum > 0 {
		hlsFlags = "independent_segments+append_list"
	}
	args = append(args,
		"-muxdelay", "0",
		"-muxpreload", "0",
		"-f", "hls",
		"-hls_time", strconv.Itoa(segDuration),
		"-hls_list_size", "0",
		"-hls_playlist_type", "event",
		"-hls_flags", hlsFlags,
		"-hls_segment_filename", segmentPath,
	)
	// On restart, resume segment numbering so seg_(crash+1).ts onwards
	// are produced by the fresh FFmpeg without overwriting any pre-crash
	// segments. The +append_list flag above ensures the playlist file is
	// extended rather than rewritten.
	//
	// 2026-05-20 — flag is `-start_number`, NOT `-hls_start_number`.
	// The HLS muxer documents `start_number` (no `hls_` prefix). The
	// old `hls_start_number` was a typo that worked on no version of
	// FFmpeg we ship — every restart attempt crashed with
	// "Unrecognized option 'hls_start_number'. Error splitting the
	// argument list". Symptom for the operator: ~4 HTTP 500s on
	// /api/stream/hls/<id>/source/seg_NNN.ts after the first FFmpeg
	// crash, until HLS.js reloaded the player session. The crash
	// itself is a separate occasional FFmpeg issue; the bug here is
	// that the *recovery* from the crash never worked.
	if resumeSegNum > 0 {
		args = append(args, "-start_number", strconv.Itoa(resumeSegNum))
	}
	args = append(args,
		"-y",
		playlistPath,
	)

	// ── Inline HLS subtitle extraction (Emby-style) ──
	// Append additional output chains for text-based subtitle tracks. Each
	// track becomes a segmented WebVTT output that piggybacks on the same
	// FFmpeg process and file I/O as the video/audio transcode — zero extra
	// disk reads. Only the first variant started for a session gets subtitle
	// outputs (subtitle content is identical across quality levels).
	if len(session.SubtitleTracks) > 0 && !session.subtitlesAttached {
		session.subtitlesAttached = true
		for i, st := range session.SubtitleTracks {
			subPlaylist := filepath.Join(session.OutputDir, fmt.Sprintf("subs_%d.m3u8", i))
			subSegPattern := filepath.Join(session.OutputDir, fmt.Sprintf("subs_%d_%%05d.vtt", i))
			args = append(args,
				// Trailing '?' makes this map optional: if the subtitle stream
				// doesn't exist (file changed between probe and transcode, or
				// corrupt container), FFmpeg skips it instead of aborting the
				// entire command — preserving video/audio playback.
				"-map", fmt.Sprintf("0:%d?", st.AbsoluteIndex),
				"-vn", "-an", // This output has no video or audio
				"-c:s", "webvtt", // Convert any text sub format to WebVTT
				// Subtitle timestamp handling (Emby-style):
				// -avoid_negative_ts disabled: prevents FFmpeg from adding
				// any PTS offset to subtitle cue times. With -copyts and
				// -start_at_zero on the input, cue times are already correct.
				"-avoid_negative_ts", "disabled",
				"-f", "segment",
				"-segment_format", "webvtt",
				"-segment_time", strconv.Itoa(segDuration),
				"-segment_list", subPlaylist,
				"-segment_list_type", "m3u8",
				"-segment_start_number", "0",
				// -individual_header_trailer 1: each .vtt segment gets its
				// own WEBVTT header. Required for standalone segment playback.
				"-individual_header_trailer", "1",
				"-break_non_keyframes", "1",
				"-map_metadata", "-1",
				// Write empty segments to maintain time alignment with
				// the video/audio HLS playlist. Without this, subtitle
				// segments that span a gap (no cues) would be missing,
				// causing HLS.js to stall or skip subtitle loading.
				"-write_empty_segments", "1",
				"-y",
				subSegPattern,
			)
		}
		slog.Info("attached inline HLS subtitles",
			"session_id", session.ID,
			"profile", p.Name,
			"tracks", len(session.SubtitleTracks),
		)
	}

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderrBuf limitedBuffer
	cmd.Stderr = &stderrBuf

	v.Cmd = cmd
	v.started = true

	go func() {
		if err := cmd.Start(); err != nil {
			v.Err = fmt.Errorf("start ffmpeg: %w", err)
			close(v.Ready)
			return
		}

		// cmdDone is closed when cmd.Wait() returns, allowing the polling
		// goroutine to exit early if FFmpeg crashes immediately.
		cmdDone := make(chan struct{})

		// Wait for first segment to appear
		go func() {
			for i := 0; i < 80; i++ {
				if _, err := os.Stat(playlistPath); err == nil {
					close(v.Ready)
					return
				}
				select {
				case <-cmdDone:
					// FFmpeg exited — check one last time for the playlist
					if _, err := os.Stat(playlistPath); err == nil {
						close(v.Ready)
						return
					}
					v.Err = fmt.Errorf("FFmpeg exited before producing playlist for %s", p.Name)
					close(v.Ready)
					return
				case <-time.After(500 * time.Millisecond):
				}
			}
			v.Err = fmt.Errorf("transcode timeout: no segments for %s", p.Name)
			close(v.Ready)
		}()

		waitErr := cmd.Wait()
		// Snapshot a bounded tail of FFmpeg's stderr so the typed v.Err
		// surfaced to EnsureVariant callers carries the actual reason for
		// the crash (OOM kill, codec failure, source EOF, etc.) — not
		// just the generic "exited unexpectedly". 2026-05-16 P1.
		stderrTail := stderrBuf.String()
		// Cap at ~600 bytes: enough for the typical "Error while opening
		// encoder for output stream #0:0 - Conversion failed" trailer
		// without bloating the log line for healthy-looking exits.
		const stderrTailMax = 600
		if len(stderrTail) > stderrTailMax {
			stderrTail = stderrTail[len(stderrTail)-stderrTailMax:]
		}
		stderrTail = strings.TrimSpace(stderrTail)
		if waitErr != nil && ctx.Err() == nil {
			// Audit M5 — log the same trimmed stderr tail used in v.Err
			// rather than the full (up to 64KB) buffer. Operators don't
			// need megabytes of probe-time noise; the trailing error is
			// what tells us WHY ffmpeg died.
			slog.Error("ffmpeg variant exited",
				"session_id", session.ID,
				"profile", p.Name,
				"error", waitErr,
				"stderr_tail", stderrTail,
			)
		}
		// Mark the variant as terminated so segment/subtitle handlers
		// can fail fast instead of spinning their retry budgets. Also
		// preserve the error so EnsureVariant callers can see it.
		session.variantMu.Lock()
		v.exited = true
		if waitErr != nil && ctx.Err() == nil && v.Err == nil {
			if stderrTail != "" {
				v.Err = fmt.Errorf("%w (ffmpeg stderr tail: %s)", waitErr, stderrTail)
			} else {
				v.Err = waitErr
			}
		}
		session.variantMu.Unlock()
		close(cmdDone)
	}()

	videoEncoder := tm.hwAccel.VideoEncoder
	audioEncoder := "aac"
	if session.Remux {
		videoEncoder = "copy"
		if session.RemuxAudioCopy {
			audioEncoder = "copy"
		}
	} else if session.AudioPassthrough {
		audioEncoder = "copy"
	}
	slog.Info("started transcode variant",
		"session_id", session.ID,
		"profile", p.Name,
		"video_encoder", videoEncoder,
		"audio_encoder", audioEncoder,
		"resolution", fmt.Sprintf("%dx%d", p.Width, p.Height),
	)

	return nil
}

// ============================================================
// HLS Serving
// ============================================================

// ServeMasterPlaylist generates and serves the adaptive master playlist.
// If queryToken is non-empty, variant URLs include ?token= for native HLS clients
// (Safari) that cannot set Authorization headers on sub-resource requests.
func (tm *TranscodeManager) ServeMasterPlaylist(w http.ResponseWriter, r *http.Request, sessionID, queryToken string) {
	s, ok := tm.GetSession(sessionID)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	baseURL := fmt.Sprintf("/api/stream/hls/%s", sessionID)
	playlist := GenerateMasterPlaylist(s.Profiles, baseURL, queryToken, s.SubtitleTracks)

	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-cache")
	if _, err := w.Write([]byte(playlist)); err != nil {
		slog.Debug("write master playlist", "session_id", sessionID, "error", err)
	}
}

// ServeVariantPlaylist serves the media playlist for a quality variant,
// starting the FFmpeg process on-demand if needed.
// If queryToken is non-empty, segment URLs are rewritten to include ?token=
// for native HLS clients (Safari).
func (tm *TranscodeManager) ServeVariantPlaylist(w http.ResponseWriter, r *http.Request, sessionID, profileName, queryToken string) {
	s, ok := tm.GetSession(sessionID)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	v, err := tm.EnsureVariant(s, profileName, s.StartSec)
	if err != nil {
		slog.Error("ensure variant failed", "session_id", sessionID, "profile", profileName, "error", err)
		http.Error(w, "variant start failed", http.StatusInternalServerError)
		return
	}

	select {
	case <-v.Ready:
	case <-r.Context().Done():
		return
	case <-time.After(40 * time.Second):
		http.Error(w, "transcode not ready", http.StatusServiceUnavailable)
		return
	}

	if v.Err != nil {
		// Log the full error server-side but don't leak FFmpeg stderr
		// (which contains filesystem paths) to the client
		slog.Error("variant error on serve", "session_id", sessionID, "profile", profileName, "error", v.Err)
		http.Error(w, "transcode failed", http.StatusInternalServerError)
		return
	}

	playlistPath := filepath.Join(v.OutputDir, "stream.m3u8")
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-cache")

	// For native HLS clients (Safari) that pass auth via ?token=,
	// rewrite segment URLs to include the token so they can authenticate.
	if queryToken != "" {
		data, err := os.ReadFile(playlistPath)
		if err != nil {
			http.Error(w, "playlist not found", http.StatusNotFound)
			return
		}
		// Append ?token= to .ts segment lines (not to #EXT directives).
		// Trim \r from EVERY line — FFmpeg may produce playlists with
		// \r\n line endings on some platforms, and stripping only the
		// rewritten lines would produce a mixed-ending output (rewritten
		// .ts lines get \n, EXT directives keep \r\n). HLS clients
		// tolerate either but mixed endings are sloppy and have
		// occasionally tripped third-party parsers. Normalize to \n
		// throughout for a clean, consistent body.
		tokenSuffix := "?token=" + queryToken
		lines := strings.Split(string(data), "\n")
		for i, line := range lines {
			trimmed := strings.TrimRight(line, "\r")
			if strings.HasSuffix(trimmed, ".ts") {
				lines[i] = trimmed + tokenSuffix
			} else {
				lines[i] = trimmed
			}
		}
		if _, err := w.Write([]byte(strings.Join(lines, "\n"))); err != nil {
			slog.Debug("write variant playlist", "session_id", sessionID, "error", err)
		}
		return
	}
	http.ServeFile(w, r, playlistPath)
}

// ServeHLSSegment serves a .ts segment from a specific quality variant.
func (tm *TranscodeManager) ServeHLSSegment(w http.ResponseWriter, r *http.Request, sessionID, profileName, segmentName string) {
	if strings.Contains(segmentName, "/") || strings.Contains(segmentName, "\\") || strings.Contains(segmentName, "..") {
		http.Error(w, "invalid segment name", http.StatusBadRequest)
		return
	}
	if !strings.HasSuffix(segmentName, ".ts") {
		http.Error(w, "invalid segment", http.StatusBadRequest)
		return
	}

	s, ok := tm.GetSession(sessionID)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	s.variantMu.Lock()
	v, vOK := s.Variants[profileName]
	s.variantMu.Unlock()

	if !vOK || !v.started {
		http.Error(w, "variant not active", http.StatusNotFound)
		return
	}

	// Wait for FFmpeg to start producing output before trying to serve segments.
	// Without this, requests that arrive between v.started=true and cmd.Start()
	// completing would get 404s.
	select {
	case <-v.Ready:
	case <-r.Context().Done():
		return
	case <-time.After(40 * time.Second):
		http.Error(w, "transcode not ready", http.StatusServiceUnavailable)
		return
	}

	if v.Err != nil {
		http.Error(w, "transcode failed", http.StatusInternalServerError)
		return
	}

	// Re-verify the session is still alive AFTER waiting on Ready. If
	// StopSession ran between the Ready-wait and now, os.RemoveAll has
	// already deleted v.OutputDir — http.ServeFile would then return a
	// confusing 404 instead of a clean "gone" signal. Checking the session
	// map again under the manager's lock gives us a deterministic 410 in
	// the teardown-race case.
	if _, stillAlive := tm.GetSession(sessionID); !stillAlive {
		http.Error(w, "session ended", http.StatusGone)
		return
	}

	segPath := filepath.Join(v.OutputDir, segmentName)

	// Track bytes served for bandwidth estimation
	if info, err := os.Stat(segPath); err == nil {
		atomic.AddInt64(&s.BytesServed, info.Size())
	}

	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set("Cache-Control", "max-age=3600")
	http.ServeFile(w, r, segPath)
}

// ServeSubtitlePlaylist serves a segmented WebVTT subtitle playlist (.m3u8)
// produced by the inline HLS subtitle extraction. Files live in the session's
// root OutputDir (not in a variant subdirectory).
// If queryToken is non-empty, segment URLs are rewritten to include ?token=
// for native HLS clients (Safari).
func (tm *TranscodeManager) ServeSubtitlePlaylist(w http.ResponseWriter, r *http.Request, sessionID, subsFile, queryToken string) {
	// Validate filename: must match subs_<N>.m3u8 exactly. The regex is
	// strictly tighter than the old prefix/suffix check and covers path
	// traversal automatically (no slashes, no dots besides the .m3u8).
	if !reSubsPlaylist.MatchString(subsFile) {
		http.Error(w, "invalid subtitle playlist name", http.StatusBadRequest)
		return
	}

	s, ok := tm.GetSession(sessionID)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	// Ensure at least one variant is running so subtitles have been produced.
	// The first variant carries the subtitle output chains.
	var primaryVariant *QualityVariant
	if len(s.Profiles) > 0 {
		v, err := tm.EnsureVariant(s, s.Profiles[0].Name, s.StartSec)
		if err != nil {
			http.Error(w, "variant not ready", http.StatusInternalServerError)
			return
		}
		select {
		case <-v.Ready:
		case <-r.Context().Done():
			return
		case <-time.After(40 * time.Second):
			http.Error(w, "subtitle not ready", http.StatusServiceUnavailable)
			return
		}
		if v.Err != nil {
			http.Error(w, "transcode failed", http.StatusInternalServerError)
			return
		}
		primaryVariant = v
	}

	playlistPath := filepath.Join(s.OutputDir, subsFile)

	// FFmpeg writes subtitle playlists AFTER the video playlist (v.Ready).
	// With many subtitle tracks (e.g., 37 tracks on Wednesday), FFmpeg
	// processes each output chain sequentially, so later tracks can take
	// 15+ seconds after video-ready. Scale the retry budget accordingly.
	maxRetries := 12 + len(s.SubtitleTracks) // base 6s + 500ms per track
	if maxRetries > 120 {
		maxRetries = 120 // cap at 60 seconds
	}
	for i := 0; i < maxRetries; i++ {
		if _, err := os.Stat(playlistPath); err == nil {
			break
		}
		// Short-circuit if ffmpeg exited without producing this subtitle
		// playlist (incompatible codec slipping past the filter, decoder
		// error, mid-run OOM). Without this we used to spin the full 60s
		// retry budget for a file that was never going to appear.
		if primaryVariant != nil && ffmpegDone(primaryVariant) {
			slog.Warn("subtitle playlist abandoned: ffmpeg exited",
				"session_id", sessionID, "file", subsFile)
			http.Error(w, "transcode ended before subtitle was produced", http.StatusNotFound)
			return
		}
		if i == maxRetries-1 {
			slog.Warn("subtitle playlist retry budget exhausted",
				"session_id", sessionID,
				"file", subsFile,
				"retries", maxRetries,
				"subtitle_tracks", len(s.SubtitleTracks),
			)
			http.Error(w, "subtitle playlist not found", http.StatusNotFound)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(500 * time.Millisecond):
		}
	}

	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-cache")

	// For native HLS clients (Safari), rewrite .vtt segment URLs to include ?token=
	if queryToken != "" {
		data, err := os.ReadFile(playlistPath)
		if err != nil {
			http.Error(w, "subtitle playlist not found", http.StatusNotFound)
			return
		}
		// Normalize all lines to LF (matches the .ts rewriter above) —
		// without the else-trim, EXT directives keep their \r and the
		// output has mixed endings.
		tokenSuffix := "?token=" + queryToken
		lines := strings.Split(string(data), "\n")
		for i, line := range lines {
			trimmed := strings.TrimRight(line, "\r")
			if strings.HasSuffix(trimmed, ".vtt") {
				lines[i] = trimmed + tokenSuffix
			} else {
				lines[i] = trimmed
			}
		}
		if _, err := w.Write([]byte(strings.Join(lines, "\n"))); err != nil {
			slog.Debug("write subtitle playlist", "session_id", sessionID, "error", err)
		}
		return
	}
	http.ServeFile(w, r, playlistPath)
}

// extractFirstPTS reads the first .ts segment of a session's first variant
// and extracts the PTS (in 90kHz ticks) of the first PES packet. This value
// is needed for X-TIMESTAMP-MAP in WebVTT subtitle segments to correctly
// align cue times with the MPEG-TS PTS clock.
//
// MPEG-TS packets are 188 bytes. We look for PES packets (PID != 0, payload
// unit start indicator set) and extract the PTS from the PES header.
// Returns 0 if no PTS is found (defensive fallback).
func extractFirstPTS(tsPath string) int64 {
	f, err := os.Open(tsPath)
	if err != nil {
		slog.Debug("extractFirstPTS: open failed", "path", tsPath, "error", err)
		return 0
	}
	defer f.Close()

	// Read first 64KB — enough to find the first PES PTS in any well-formed
	// MPEG-TS file (typically within the first few packets).
	buf := make([]byte, 65536)
	n, err := f.Read(buf)
	if err != nil || n < 188 {
		slog.Debug("extractFirstPTS: read too short", "path", tsPath, "n", n)
		return 0
	}
	buf = buf[:n]

	const tsPacketSize = 188

	for offset := 0; offset+tsPacketSize <= len(buf); offset += tsPacketSize {
		pkt := buf[offset : offset+tsPacketSize]

		// Sync byte check
		if pkt[0] != 0x47 {
			// Try to resync — skip until we find 0x47
			found := false
			for i := offset + 1; i+tsPacketSize <= len(buf); i++ {
				if buf[i] == 0x47 {
					offset = i - tsPacketSize // will be incremented by loop
					found = true
					break
				}
			}
			if !found {
				break
			}
			continue
		}

		// Payload Unit Start Indicator (bit 6 of byte 1)
		pusi := (pkt[1] & 0x40) != 0
		if !pusi {
			continue
		}

		// PID (13 bits: bits 4-0 of byte 1 + all of byte 2)
		pid := uint16(pkt[1]&0x1F)<<8 | uint16(pkt[2])

		// Skip PAT (PID 0), CAT (PID 1), PMT (typically PID 0x1000 range)
		// and null packets (PID 0x1FFF). We want elementary stream PIDs
		// which carry audio/video PES packets.
		if pid == 0 || pid == 1 || pid == 0x1FFF {
			continue
		}

		// Adaptation field control (bits 5-4 of byte 3)
		afc := (pkt[3] >> 4) & 0x03
		payloadStart := 4
		if afc == 2 {
			continue // adaptation field only, no payload
		}
		if afc == 3 {
			// adaptation field + payload
			afLen := int(pkt[4])
			payloadStart = 5 + afLen
		}

		if payloadStart+14 > tsPacketSize {
			continue // not enough room for PES header
		}

		payload := pkt[payloadStart:]

		// PES start code: 00 00 01
		if len(payload) < 14 || payload[0] != 0 || payload[1] != 0 || payload[2] != 1 {
			continue
		}

		// Stream ID byte (payload[3]):
		// 0xE0-0xEF = video, 0xC0-0xDF = audio, 0xBD = private stream 1
		streamID := payload[3]
		isAV := (streamID >= 0xC0 && streamID <= 0xEF) || streamID == 0xBD
		if !isAV {
			continue
		}

		// PTS/DTS flags (bits 7-6 of payload[7])
		ptsDtsFlags := (payload[7] >> 6) & 0x03
		if ptsDtsFlags < 2 {
			continue // no PTS
		}

		// PTS is in payload[9..13]: 5 bytes with marker bits
		if len(payload) < 14 {
			continue
		}

		// Extract 33-bit PTS from the 5 PTS bytes:
		// Byte 0: [0011 xxx1] where xxx = PTS[32..30]
		// Byte 1: [xxxx xxxx] PTS[29..22]
		// Byte 2: [xxxx xxx1] PTS[21..15]
		// Byte 3: [xxxx xxxx] PTS[14..7]
		// Byte 4: [xxxx xxx1] PTS[6..0]
		ptsBytes := payload[9:14]
		pts := (int64(ptsBytes[0]>>1) & 0x07) << 30
		pts |= int64(binary.BigEndian.Uint16(ptsBytes[1:3])>>1) << 15
		pts |= int64(binary.BigEndian.Uint16(ptsBytes[3:5]) >> 1)

		slog.Debug("extractFirstPTS: found PTS",
			"path", tsPath,
			"pid", pid,
			"stream_id", fmt.Sprintf("0x%02X", streamID),
			"pts_90khz", pts,
			"pts_seconds", float64(pts)/90000.0,
		)
		return pts
	}

	slog.Debug("extractFirstPTS: no PTS found in first 64KB", "path", tsPath)
	return 0
}

// getSessionInitPTS returns the cached initial PTS for the session. On first
// call, it reads the first .ts segment of the first variant to extract the
// actual PTS value. This is needed because the MPEG-TS muxer may add a
// non-zero PTS offset even when -start_at_zero is used, and the X-TIMESTAMP-MAP
// in WebVTT subtitle segments must match this offset for HLS.js to
// correctly synchronize cue times.
func (tm *TranscodeManager) getSessionInitPTS(s *TranscodeSession) int64 {
	// Fast path: already probed and cached.
	cached := atomic.LoadInt64(&s.initPTS90kHz)
	if cached >= 0 {
		return cached
	}

	// CAS from -1 (not probed) to -2 (probe in progress).
	// Only one goroutine wins; others see -2 and return 0 (safe fallback).
	if !atomic.CompareAndSwapInt64(&s.initPTS90kHz, -1, -2) {
		// Another goroutine is probing or already probed.
		if pts := atomic.LoadInt64(&s.initPTS90kHz); pts >= 0 {
			return pts
		}
		return 0
	}

	// This goroutine owns the probe. Find the first profile's variant
	// deterministically (Profiles[0] is always the same variant).
	s.variantMu.Lock()
	var firstVariantDir string
	if len(s.Profiles) > 0 {
		if v, ok := s.Variants[s.Profiles[0].Name]; ok && v.started {
			firstVariantDir = v.OutputDir
		}
	}
	s.variantMu.Unlock()

	if firstVariantDir == "" {
		// No variant started yet. Reset to -1 so next request retries.
		atomic.StoreInt64(&s.initPTS90kHz, -1)
		return 0
	}

	firstSeg := filepath.Join(firstVariantDir, "seg_00000.ts")
	info, err := os.Stat(firstSeg)
	if err != nil || info.Size() < 1024 {
		// Segment doesn't exist or still being written. Reset to -1 for retry.
		atomic.StoreInt64(&s.initPTS90kHz, -1)
		return 0
	}

	pts := extractFirstPTS(firstSeg)
	atomic.StoreInt64(&s.initPTS90kHz, pts)
	slog.Info("session initial PTS probed",
		"session_id", s.ID,
		"pts_90khz", pts,
		"pts_seconds", fmt.Sprintf("%.3f", float64(pts)/90000.0),
	)
	return pts
}

// ServeSubtitleSegment serves a WebVTT subtitle segment (.vtt) produced by
// the inline HLS subtitle extraction. Files live in the session's root
// OutputDir (not in a variant subdirectory).
//
// Each segment is post-processed to inject X-TIMESTAMP-MAP after the WEBVTT
// header. HLS requires this mapping to align WebVTT cue times with the
// MPEG-TS PTS timeline. The MPEGTS value must match the actual initial PTS
// of the .ts segments — a mismatch causes HLS.js to shift subtitle cue
// times by the difference, making subtitles appear early or late.
//
// The initial PTS is read from the first .ts segment and cached on the
// session. With -muxdelay 0 -muxpreload 0 on the HLS output, PTS is
// near 0 (typically <100ms from codec delay or B-frame reordering).
func (tm *TranscodeManager) ServeSubtitleSegment(w http.ResponseWriter, r *http.Request, sessionID, segmentName string) {
	// Validate: must match subs_<track>_<segment>.vtt exactly.
	if !reSubsSegment.MatchString(segmentName) {
		http.Error(w, "invalid subtitle segment name", http.StatusBadRequest)
		return
	}

	s, ok := tm.GetSession(sessionID)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	segPath := filepath.Join(s.OutputDir, segmentName)

	// Read the segment and inject X-TIMESTAMP-MAP for HLS timing alignment.
	// FFmpeg's segment muxer produces valid WebVTT segments (with WEBVTT
	// header) but does NOT include X-TIMESTAMP-MAP, which HLS.js needs to
	// correctly sync cue times to the MPEG-TS PTS clock.
	data, err := os.ReadFile(segPath)
	if err != nil {
		http.Error(w, "subtitle segment not found", http.StatusNotFound)
		return
	}

	// Inject X-TIMESTAMP-MAP=MPEGTS:<initPTS>,LOCAL:00:00:00.000 so HLS.js
	// can align WebVTT cue times with the MPEG-TS PTS clock.
	//
	// With -muxdelay 0 -muxpreload 0 on the HLS output, the initial
	// video PTS is near 0 (typically <100ms from codec delay/B-frames).
	// The probed initPTS therefore matches HLS.js's own initPTS,
	// making webVttMpegTsMapOffset = 0 and subtitle cue times map
	// directly to the presentation timeline.
	//
	// We still probe the actual PTS (rather than hardcoding 0) to handle
	// edge cases: codec delay, B-frame reordering, or full transcode
	// mode where genpts may produce a small non-zero initial PTS.
	initPTS := tm.getSessionInitPTS(s)
	timestampMap := fmt.Sprintf("X-TIMESTAMP-MAP=MPEGTS:%d,LOCAL:00:00:00.000\n", initPTS)

	// Empty segments are normal: -write_empty_segments 1 produces 0-byte
	// .vtt files for time windows with no subtitle cues. Return a valid
	// empty WebVTT segment with the timestamp map.
	if len(data) == 0 {
		content := "WEBVTT\n" + timestampMap + "\n"
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
		w.Header().Set("Cache-Control", "max-age=3600")
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.Write([]byte(content))
		return
	}

	// Inject X-TIMESTAMP-MAP after the "WEBVTT" header line.
	// FFmpeg produces: "WEBVTT\n\n00:01.000 --> ..."
	// We transform to: "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:N,LOCAL:00:00:00.000\n\n00:01.000 --> ..."
	// Also handle \r\n line endings (FFmpeg may produce these on some platforms).
	content := string(data)
	if strings.HasPrefix(content, "WEBVTT\r\n") {
		content = "WEBVTT\n" + timestampMap + content[len("WEBVTT\r\n"):]
	} else if strings.HasPrefix(content, "WEBVTT\n") {
		content = "WEBVTT\n" + timestampMap + content[len("WEBVTT\n"):]
	} else {
		// Defensive: if WEBVTT header is missing (shouldn't happen with
		// default FFmpeg settings), prepend the full header.
		slog.Warn("subtitle segment missing WEBVTT header",
			"session_id", sessionID,
			"segment", segmentName,
		)
		content = "WEBVTT\n" + timestampMap + "\n" + content
	}

	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "max-age=3600")
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	if _, err := w.Write([]byte(content)); err != nil {
		slog.Debug("write subtitle segment", "session_id", sessionID, "error", err)
	}
}

// ============================================================
// Backward Compatibility
// ============================================================

// GetOrCreateSession provides backward compat with Phase 2 callers.
func (tm *TranscodeManager) GetOrCreateSession(filePath string, startSec int, userID int64, username string, sourceWidth, sourceHeight int) (*TranscodeSession, error) {
	tm.mu.Lock()
	for _, s := range tm.sessions {
		if s.FilePath == filePath && s.UserID == userID {
			s.LastAccess = time.Now()
			tm.mu.Unlock()
			return s, nil
		}
	}
	tm.mu.Unlock()

	session, err := tm.CreateSession(userID, username, filePath, sourceWidth, sourceHeight, SessionOpts{StartSec: startSec})
	if err != nil {
		return nil, err
	}

	if len(session.Profiles) > 0 {
		if _, err := tm.EnsureVariant(session, session.Profiles[0].Name, session.StartSec); err != nil {
			slog.Warn("failed to auto-start variant", "error", err)
		}
	}

	return session, nil
}

// primaryProfileName returns the name of the first quality profile in a session,
// or an empty string if there are no profiles. Used for event payloads.
func (tm *TranscodeManager) primaryProfileName(s *TranscodeSession) string {
	if len(s.Profiles) > 0 {
		return s.Profiles[0].Name
	}
	return ""
}

// ============================================================
// Utilities
// ============================================================

const maxLimitedBuf = 64 * 1024

type limitedBuffer struct {
	buf []byte
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := maxLimitedBuf - len(b.buf)
	if remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		b.buf = append(b.buf, p...)
	}
	return n, nil
}

func (b *limitedBuffer) String() string {
	return string(b.buf)
}

// ============================================================
// Process Resource Tracking (Feature 3)
// ============================================================

// collectProcessResources reads CPU and memory usage from /proc for FFmpeg PIDs.
func collectProcessResources(pids []int) *SessionResources {
	res := &SessionResources{NumProcesses: len(pids)}

	for _, pid := range pids {
		// Read RSS from /proc/<pid>/statm (field 1 = RSS in pages)
		statm, err := os.ReadFile(fmt.Sprintf("/proc/%d/statm", pid))
		if err != nil {
			continue // Process may have exited
		}
		fields := strings.Fields(string(statm))
		if len(fields) >= 2 {
			rssPages, _ := strconv.ParseInt(fields[1], 10, 64)
			res.MemoryBytes += rssPages * 4096 // Standard page size
		}

		// Read CPU times from /proc/<pid>/stat (fields 13+14 = utime+stime in clock ticks)
		stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil {
			continue
		}
		// /proc/pid/stat has the comm field in parens which can contain spaces.
		// Find the closing paren and parse fields after it.
		statStr := string(stat)
		closeParen := strings.LastIndex(statStr, ")")
		if closeParen < 0 || closeParen+2 >= len(statStr) {
			continue
		}
		afterComm := strings.Fields(statStr[closeParen+2:])
		// afterComm[0]=state, [1]=ppid, ..., [11]=utime, [12]=stime
		if len(afterComm) >= 13 {
			utime, _ := strconv.ParseFloat(afterComm[11], 64)
			stime, _ := strconv.ParseFloat(afterComm[12], 64)
			// Convert clock ticks to approximate CPU percentage:
			// ticks / (uptime_seconds * clock_ticks_per_sec) * 100
			// Simplified: report raw ticks as a rough indicator.
			// For a more accurate %, we'd need two snapshots, but for an admin
			// dashboard this gives a useful relative measure.
			res.CPUTicks += (utime + stime) / 100.0 // SC_CLK_TCK is typically 100
		}
	}

	return res
}

// ============================================================
// HDR-to-SDR Tonemapping Filter Injection
// ============================================================

// injectTonemapFilter replaces the video filter chain to add HDR-to-SDR
// tonemapping. This is needed when transcoding 10-bit HEVC HDR content to
// 8-bit H.264 to prevent washed-out colors. The Hable tonemapping algorithm
// with desaturation produces natural-looking SDR output.
//
// Software pipeline: zscale + tonemap + format conversion before scale.
// VAAPI pipeline: tonemapping is not yet supported (filters are CPU-only);
// a warning is logged and no tonemapping is applied.
func injectTonemapFilter(args []string, width, height int) []string {
	result := make([]string, 0, len(args)+2)
	for i := 0; i < len(args); i++ {
		if args[i] == "-vf" && i+1 < len(args) {
			existingVF := args[i+1]
			if strings.Contains(existingVF, "hwupload") {
				// VAAPI pipeline: tonemapping filters are CPU-only and cannot
				// operate on hardware surfaces. Fall through without tonemapping.
				slog.Warn("HDR tonemapping requested but VAAPI pipeline does not support CPU-side tonemap filters; skipping")
				result = append(result, args[i], existingVF)
			} else {
				// Software/NVENC/QSV/AMF pipeline: inject tonemap before scale.
				// Chain: zscale(linearize) → format(float) → zscale(bt709) → tonemap → zscale(tv) → format(yuv420p) → scale
				tonemap := fmt.Sprintf(
					"zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale=%d:-2",
					width,
				)
				result = append(result, "-vf", tonemap)
			}
			i++ // skip original filter value
			continue
		}
		result = append(result, args[i])
	}
	return result
}

// ============================================================
// Subtitle Burn-In Filter Injection
// ============================================================

// injectBurnInFilter modifies existing encoder args to chain subtitle burn-in
// with the video scale filter. This handles both text and bitmap subtitles.
//
// Special handling for VAAPI: the VAAPI pipeline uses hwupload+scale_vaapi in
// the -vf chain. Subtitle and overlay are CPU-only filters and cannot operate
// on hardware surfaces. When VAAPI is detected (via "hwupload" in -vf), we
// restructure to apply subtitle/overlay BEFORE hwupload.
func injectBurnInFilter(args []string, session *TranscodeSession) []string {
	if session.BurnSubBitmap {
		// Bitmap subs (PGS, VOBSUB) use overlay filter — replaces -vf with -filter_complex.
		// We extract the existing -vf value (typically a scale filter) and chain it
		// into the filter_complex so the output resolution matches the profile target.
		var existingVF string
		result := make([]string, 0, len(args)+2)
		for i := 0; i < len(args); i++ {
			if args[i] == "-vf" && i+1 < len(args) {
				existingVF = args[i+1] // Capture scale filter before stripping
				i++                    // skip the filter value too
				continue
			}
			result = append(result, args[i])
		}

		// VAAPI pipeline: overlay must happen on CPU frames, before hwupload.
		// Restructure: [0:v][0:N]overlay,<vaapi_pipeline>
		if strings.Contains(existingVF, "hwupload") {
			return append(result, "-filter_complex",
				fmt.Sprintf("[0:v][0:%d]overlay,%s", session.BurnSubIndex, existingVF))
		}

		return append(result, BurnInBitmapArgs(session.BurnSubIndex, existingVF)...)
	}

	// Text-based subs (SRT, ASS, SSA) — chain with existing scale filter
	var burnFilter string
	if session.BurnSubExternal != "" {
		escaped := escapeFFmpegPath(session.BurnSubExternal)
		burnFilter = fmt.Sprintf("subtitles=%s", escaped)
	} else {
		escaped := escapeFFmpegPath(session.FilePath)
		burnFilter = fmt.Sprintf("subtitles=%s:stream_index=%d", escaped, session.BurnSubIndex)
	}

	result := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		if args[i] == "-vf" && i+1 < len(args) {
			existingVF := args[i+1]
			if strings.Contains(existingVF, "hwupload") {
				// VAAPI pipeline: subtitle filter is CPU-only, must run before hwupload.
				// Prepend: subtitles=...,format=nv12,hwupload,scale_vaapi=...
				result = append(result, "-vf", burnFilter+","+existingVF)
			} else {
				// CPU pipeline (NVENC/QSV/AMF/software): append after scale.
				// Chain: scale=WxH,subtitles=...
				result = append(result, "-vf", existingVF+","+burnFilter)
			}
			i++ // skip original filter value
		} else {
			result = append(result, args[i])
		}
	}
	return result
}
