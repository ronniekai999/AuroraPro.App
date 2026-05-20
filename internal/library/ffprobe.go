package library

import (
	"context"
	"encoding/json"
	"fmt"
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

	// Multi-track info (Gap 2)
	AudioTracks    []models.AudioTrack    `json:"audio_tracks,omitempty"`
	SubtitleTracks []models.SubtitleTrack `json:"subtitle_tracks,omitempty"`
}

type ffprobeOutput struct {
	Streams []ffprobeStream `json:"streams"`
	Format  ffprobeFormat   `json:"format"`
}

type ffprobeStream struct {
	Index       int               `json:"index"`
	CodecType   string            `json:"codec_type"`
	CodecName   string            `json:"codec_name"`
	Profile     string            `json:"profile"`
	PixFmt      string            `json:"pix_fmt"`
	Level       int               `json:"level"`
	Width       int               `json:"width"`
	Height      int               `json:"height"`
	Channels    int               `json:"channels"`
	Tags        map[string]string `json:"tags"`
	Disposition ffprobeDisp       `json:"disposition"`
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

	// Track counters for audio and subtitle indexing
	audioIdx := 0
	subtitleIdx := 0

	// Streams — collect ALL audio and subtitle tracks
	for _, stream := range probe.Streams {
		switch stream.CodecType {
		case "video":
			if result.VideoCodec == "" { // Take first video stream
				result.VideoCodec = stream.CodecName
				result.VideoProfile = stream.Profile
				result.VideoPixFmt = stream.PixFmt
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
			track := models.SubtitleTrack{
				Index:    subtitleIdx,
				Language: stream.Tags["language"],
				Title:    stream.Tags["title"],
				Codec:    stream.CodecName,
				Forced:   stream.Disposition.Forced == 1,
				Default:  stream.Disposition.Default == 1,
			}
			result.SubtitleTracks = append(result.SubtitleTracks, track)
			subtitleIdx++
		}
	}

	return result, nil
}
