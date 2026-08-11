package library

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/streaming"
)

type ProbeResult struct {
	Container  string
	VideoCodec string
	AudioCodec string // First audio track codec (backward compat)
	Resolution string
	Bitrate    int64
	DurationMs int64

	// Video stream profile info (H.264 10-bit detection)
	VideoProfile string // e.g., "High", "High 10", "Main"
	VideoPixFmt  string // e.g., "yuv420p", "yuv420p10le"

	// Color metadata — needed to distinguish HDR (PQ/HLG) from SDR
	// 10-bit. Without these, the transcode pipeline would mis-apply
	// HDR-to-SDR tonemapping to SDR sources and crash zscale with
	// "no path between colorspaces". 2026-05-24 fix.
	ColorTransfer  string // e.g., "bt709", "smpte2084" (PQ), "arib-std-b67" (HLG)
	ColorPrimaries string // e.g., "bt709", "bt2020"

	// VideoFPS is the video stream's AVERAGE frame rate parsed from
	// ffprobe's avg_frame_rate (r_frame_rate as fallback). 0 = unknown.
	// The H.264 level table uses it to stamp truthful levels for >30fps
	// content (1080p60 → 4.2, 2160p60 → 5.2). Average rate is the right
	// input for VFR content: the level only needs to separate the
	// ≤30fps world from the 50/60fps world, and avg vs peak rates never
	// sit on opposite sides of that boundary for real content.
	VideoFPS float64

	// Multi-track info (Gap 2)
	AudioTracks    []models.AudioTrack    `json:"audio_tracks,omitempty"`
	SubtitleTracks []models.SubtitleTrack `json:"subtitle_tracks,omitempty"`
}

type ffprobeOutput struct {
	Streams []ffprobeStream `json:"streams"`
	Format  ffprobeFormat   `json:"format"`
}

type ffprobeStream struct {
	Index          int               `json:"index"`
	CodecType      string            `json:"codec_type"`
	CodecName      string            `json:"codec_name"`
	Profile        string            `json:"profile"`
	PixFmt         string            `json:"pix_fmt"`
	Level          int               `json:"level"`
	Width          int               `json:"width"`
	Height         int               `json:"height"`
	Channels       int               `json:"channels"`
	ColorTransfer  string            `json:"color_transfer"`  // e.g. "smpte2084", "arib-std-b67", "bt709"
	ColorPrimaries string            `json:"color_primaries"` // e.g. "bt2020", "bt709"
	AvgFrameRate   string            `json:"avg_frame_rate"`  // e.g. "30000/1001", "60/1", "0/0"
	RFrameRate     string            `json:"r_frame_rate"`    // fallback when avg is 0/0
	Tags           map[string]string `json:"tags"`
	Disposition    ffprobeDisp       `json:"disposition"`
}

type ffprobeDisp struct {
	Default int `json:"default"`
	Forced  int `json:"forced"`
}

type ffprobeFormat struct {
	FormatName string `json:"format_name"`
	Duration   string `json:"duration"`
	BitRate    string `json:"bit_rate"`
}

// Probe runs ffprobe on a media file and returns structured metadata
func Probe(ctx context.Context, ffprobePath, filePath string) (*ProbeResult, error) {
	cmd := exec.CommandContext(ctx, ffprobePath,
		"-v", "quiet",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		filePath,
	)

	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe %s: %w", filePath, err)
	}

	var probe ffprobeOutput
	if err := json.Unmarshal(output, &probe); err != nil {
		return nil, fmt.Errorf("parse ffprobe output: %w", err)
	}

	result := &ProbeResult{}

	// Container — normalize FFprobe format names (e.g., "matroska" → "mkv", "mov" → "mp4")
	if probe.Format.FormatName != "" {
		parts := strings.Split(probe.Format.FormatName, ",")
		result.Container = streaming.NormalizeContainer(parts[0])
	}

	// Duration (seconds string -> milliseconds)
	if probe.Format.Duration != "" {
		if dur, err := strconv.ParseFloat(probe.Format.Duration, 64); err == nil {
			result.DurationMs = int64(dur * 1000)
		}
	}

	// Bitrate
	if probe.Format.BitRate != "" {
		result.Bitrate, _ = strconv.ParseInt(probe.Format.BitRate, 10, 64)
	}

	// Audio track index is AUDIO-RELATIVE (0 = first audio stream), which is
	// what FFmpeg's `-map 0:a:N` selector and the playback decision engine
	// expect. Subtitle tracks, by contrast, are keyed by their ABSOLUTE
	// ffprobe stream index (see the subtitle case below).
	audioIdx := 0

	// Streams — collect ALL audio and subtitle tracks
	for _, stream := range probe.Streams {
		switch stream.CodecType {
		case "video":
			if result.VideoCodec == "" { // Take first video stream
				result.VideoCodec = stream.CodecName
				result.VideoProfile = stream.Profile
				result.VideoPixFmt = stream.PixFmt
				result.ColorTransfer = stream.ColorTransfer
				result.ColorPrimaries = stream.ColorPrimaries
				result.VideoFPS = parseFrameRate(stream.AvgFrameRate)
				if result.VideoFPS <= 0 {
					result.VideoFPS = parseFrameRate(stream.RFrameRate)
				}
				if stream.Width > 0 && stream.Height > 0 {
					result.Resolution = fmt.Sprintf("%dx%d", stream.Width, stream.Height)
				}
			}
		case "audio":
			track := models.AudioTrack{
				Index:     audioIdx,
				Codec:     stream.CodecName,
				Channels:  stream.Channels,
				Language:  stream.Tags["language"],
				Title:     stream.Tags["title"],
				IsDefault: stream.Disposition.Default == 1,
			}
			audioIdx++
			result.AudioTracks = append(result.AudioTracks, track)

			// Backward compat: first audio track populates AudioCodec
			if result.AudioCodec == "" {
				result.AudioCodec = stream.CodecName
			}
		case "subtitle":
			// Subtitle Index is the ABSOLUTE ffprobe stream index, NOT a
			// subtitle-relative counter. This matches streaming.ProbeSubtitles
			// (the runtime probe every serve/burn-in path uses) and the
			// `-map 0:N` / ExtractSubtitleVTT extraction, which address
			// subtitles by absolute index. Storing a relative counter here
			// gave the same track two different "Index" meanings between scan
			// time and serve time — a latent wrong-track footgun.
			track := models.SubtitleTrack{
				Index:    stream.Index,
				Language: stream.Tags["language"],
				Title:    stream.Tags["title"],
				Codec:    stream.CodecName,
				Forced:   stream.Disposition.Forced == 1,
				Default:  stream.Disposition.Default == 1,
			}
			result.SubtitleTracks = append(result.SubtitleTracks, track)
		}
	}

	return result, nil
}

// parseFrameRate converts ffprobe's rational frame-rate strings
// ("30000/1001", "60/1", "25") to fps. Returns 0 for "0/0", empty,
// malformed, or zero-denominator values — the caller treats 0 as
// "unknown" and keeps the resolution-only level choice.
func parseFrameRate(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	num, den := s, "1"
	if i := strings.IndexByte(s, '/'); i >= 0 {
		num, den = s[:i], s[i+1:]
	}
	n, errN := strconv.ParseFloat(num, 64)
	d, errD := strconv.ParseFloat(den, 64)
	if errN != nil || errD != nil || d <= 0 || n <= 0 {
		return 0
	}
	v := n / d
	// ParseFloat ACCEPTS "NaN" and overflowing exponents ("1e999" → +Inf).
	// Storing either would poison the DB row (Postgres REAL takes NaN) and
	// break encoding/json on every API response carrying this file — guard
	// both. (ffprobe never emits them; this is pure defense.)
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}
