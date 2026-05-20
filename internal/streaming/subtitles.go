package streaming

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// ProbeSubtitles uses ffprobe to discover subtitle tracks in a media file.
func ProbeSubtitles(ctx context.Context, filePath string) ([]models.SubtitleTrack, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "quiet",
		"-print_format", "json",
		"-show_streams",
		"-select_streams", "s", // subtitle streams only
		filePath,
	)

	out, err := cmd.Output()
	if err != nil {
		// No subtitle streams is not an error
		return nil, nil
	}

	var probe struct {
		Streams []struct {
			Index       int               `json:"index"`
			CodecName   string            `json:"codec_name"`
			CodecType   string            `json:"codec_type"`
			Tags        map[string]string `json:"tags"`
			Disposition struct {
				Default int `json:"default"`
				Forced  int `json:"forced"`
			} `json:"disposition"`
		} `json:"streams"`
	}

	if err := json.Unmarshal(out, &probe); err != nil {
		return nil, fmt.Errorf("parse ffprobe subtitle output: %w", err)
	}

	var tracks []models.SubtitleTrack
	for _, s := range probe.Streams {
		if s.CodecType != "subtitle" {
			continue
		}
		track := models.SubtitleTrack{
			Index:    s.Index,
			Language: s.Tags["language"],
			Title:    s.Tags["title"],
			Codec:    s.CodecName,
			Forced:   s.Disposition.Forced == 1,
			Default:  s.Disposition.Default == 1,
		}
		tracks = append(tracks, track)
	}

	return tracks, nil
}

// ExtractSubtitleVTT extracts a subtitle track and converts it to WebVTT format.
// Returns the path to the generated .vtt file.
func ExtractSubtitleVTT(ctx context.Context, filePath string, streamIndex int, cacheDir string) (string, error) {
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		return "", fmt.Errorf("create subtitle cache dir: %w", err)
	}

	// Generate a stable filename using path hash to avoid collisions between
	// media files with the same basename in different directories
	h := sha256.Sum256([]byte(filePath))
	baseName := strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath))
	vttPath := filepath.Join(cacheDir, fmt.Sprintf("%s_%x_sub%d.vtt", baseName, h[:6], streamIndex))

	// Return cached version if it exists and has content.
	// A previous extraction may have been killed mid-write (timeout, signal),
	// leaving a 0-byte or truncated file that would serve an empty subtitle.
	if info, err := os.Stat(vttPath); err == nil && info.Size() > 0 {
		return vttPath, nil
	}

	// 10 minutes: large MKV files (8+ GB) require reading through the entire
	// container to collect interleaved subtitle packets. On spinning disks or
	// network mounts this can take several minutes for 4K files.
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-i", filePath,
		"-map", fmt.Sprintf("0:%d", streamIndex),
		"-c:s", "webvtt",
		"-y",
		vttPath,
	)

	if output, err := cmd.CombinedOutput(); err != nil {
		os.Remove(vttPath) // Clean up partial file
		return "", fmt.Errorf("extract subtitle: %w: %s", err, string(output))
	}

	return vttPath, nil
}

// ServeSubtitle serves a VTT subtitle file with proper headers.
func ServeSubtitle(w http.ResponseWriter, r *http.Request, vttPath string) {
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "max-age=86400")
	// CORS headers are set by the router-level CORS middleware based on AllowedOrigins.
	// Do NOT set Access-Control-Allow-Origin here — it would bypass the CORS policy.
	http.ServeFile(w, r, vttPath)
}

// ConvertSRTtoVTT converts an external .srt file to .vtt format.
// Output is written to cacheDir to avoid issues with read-only media mounts.
func ConvertSRTtoVTT(srtPath, cacheDir string) (string, error) {
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		return "", fmt.Errorf("create subtitle cache dir: %w", err)
	}

	// Use a hash of the full path to avoid collisions between SRT files
	// with the same name in different directories
	h := sha256.Sum256([]byte(srtPath))
	baseName := strings.TrimSuffix(filepath.Base(srtPath), ".srt")
	vttPath := filepath.Join(cacheDir, fmt.Sprintf("%s_%x.vtt", baseName, h[:6]))

	// Return cached version if it exists and is newer than the SRT
	srtInfo, err := os.Stat(srtPath)
	if err != nil {
		return "", err
	}
	if vttInfo, err := os.Stat(vttPath); err == nil && vttInfo.ModTime().After(srtInfo.ModTime()) {
		return vttPath, nil
	}

	// Read SRT
	srtFile, err := os.Open(srtPath)
	if err != nil {
		return "", err
	}
	defer srtFile.Close()

	// Write VTT
	vttFile, err := os.Create(vttPath)
	if err != nil {
		return "", err
	}
	defer vttFile.Close()

	w := bufio.NewWriter(vttFile)
	w.WriteString("WEBVTT\n\n")

	// SRT timestamp pattern: 00:00:00,000 --> 00:00:00,000
	// VTT uses periods instead of commas in timestamps
	srtTimestamp := regexp.MustCompile(`^(\d{2}:\d{2}:\d{2}),(\d{3})\s*(-->)\s*(\d{2}:\d{2}:\d{2}),(\d{3})`)

	scanner := bufio.NewScanner(srtFile)
	for scanner.Scan() {
		line := scanner.Text()
		// Only convert commas to periods in timestamp lines
		if srtTimestamp.MatchString(line) {
			line = srtTimestamp.ReplaceAllString(line, "${1}.${2} ${3} ${4}.${5}")
		}
		w.WriteString(line + "\n")
	}

	if err := scanner.Err(); err != nil {
		os.Remove(vttPath)
		return "", err
	}

	if err := w.Flush(); err != nil {
		os.Remove(vttPath)
		return "", err
	}

	return vttPath, nil
}

// ConvertSubtitleToVTT converts any subtitle file (ASS, SSA, SUB, etc.) to WebVTT
// using ffmpeg. This handles formats that ConvertSRTtoVTT (pure Go) cannot.
// Output is written to cacheDir to avoid issues with read-only media mounts.
func ConvertSubtitleToVTT(ctx context.Context, subPath string, cacheDir string) (string, error) {
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		return "", fmt.Errorf("create subtitle cache dir: %w", err)
	}

	h := sha256.Sum256([]byte(subPath))
	baseName := strings.TrimSuffix(filepath.Base(subPath), filepath.Ext(subPath))
	vttPath := filepath.Join(cacheDir, fmt.Sprintf("%s_%x.vtt", baseName, h[:6]))

	// Return cached version if it exists and is newer than the source
	srcInfo, err := os.Stat(subPath)
	if err != nil {
		return "", err
	}
	if vttInfo, err := os.Stat(vttPath); err == nil && vttInfo.Size() > 0 && vttInfo.ModTime().After(srcInfo.ModTime()) {
		return vttPath, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-i", subPath,
		"-c:s", "webvtt",
		"-y",
		vttPath,
	)

	if output, err := cmd.CombinedOutput(); err != nil {
		os.Remove(vttPath) // Clean up partial file
		return "", fmt.Errorf("convert subtitle: %w: %s", err, string(output))
	}

	return vttPath, nil
}

// FindExternalSubtitles discovers .srt, .vtt, .ass files next to a media file.
func FindExternalSubtitles(mediaPath string) []models.SubtitleTrack {
	dir := filepath.Dir(mediaPath)
	base := strings.TrimSuffix(filepath.Base(mediaPath), filepath.Ext(mediaPath))

	var tracks []models.SubtitleTrack
	subtitleExts := []string{".srt", ".vtt", ".ass", ".ssa"}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	idx := 1000 // Start external sub indices high to avoid collision with embedded
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		ext := strings.ToLower(filepath.Ext(name))

		isSubtitle := false
		for _, se := range subtitleExts {
			if ext == se {
				isSubtitle = true
				break
			}
		}
		if !isSubtitle {
			continue
		}

		// Must match the media file base name
		// e.g., "Movie.2024.eng.srt" matches "Movie.2024.mkv"
		if !strings.HasPrefix(name, base) {
			continue
		}

		// Extract language hint from filename
		// e.g., "Movie.2024.eng.srt" → "eng"
		remainder := strings.TrimPrefix(name, base)
		remainder = strings.TrimSuffix(remainder, ext)
		remainder = strings.Trim(remainder, ".")

		lang := "und" // unknown
		if remainder != "" {
			parts := strings.Split(remainder, ".")
			lang = parts[len(parts)-1]
		}

		track := models.SubtitleTrack{
			Index:    idx,
			Language: lang,
			Title:    filepath.Join(dir, name), // Full path for internal use by ServeSubtitle handler
			Codec:    strings.TrimPrefix(ext, "."),
		}
		tracks = append(tracks, track)
		idx++
	}

	return tracks
}

// ============================================================
// Phase 3: Subtitle Burn-In
// ============================================================

// BurnInArgs returns FFmpeg filter arguments to burn subtitles into the video stream.
// For embedded subs, streamIndex is the subtitle stream index within the container.
// For external subs, externalPath is the path to the .srt/.ass/.ssa file.
// These args are designed to be appended to the -vf filter chain.
//
// Note: burn-in happens when the client can't render subtitles natively (e.g.,
// PGS bitmap subs on a web player, or ASS subs with complex styling).
func BurnInArgs(mediaPath string, streamIndex int, externalPath string) []string {
	if externalPath != "" {
		// External subtitle file — use the subtitles filter directly
		// Escape special characters for FFmpeg filter syntax
		escaped := escapeFFmpegPath(externalPath)
		return []string{"-vf", fmt.Sprintf("subtitles=%s", escaped)}
	}

	// Embedded subtitle — reference the input file and stream index
	escaped := escapeFFmpegPath(mediaPath)
	return []string{"-vf", fmt.Sprintf("subtitles=%s:stream_index=%d", escaped, streamIndex)}
}

// BurnInBitmapArgs returns FFmpeg filter arguments to burn bitmap-based subtitles
// (PGS, DVB, VOBSUB) into the video stream. These require overlay instead of the
// text-based subtitles filter.
// streamIndex is the ABSOLUTE stream index (from ffprobe), not subtitle-relative.
func BurnInBitmapArgs(streamIndex int, scaleFilter string) []string {
	// Build filter_complex that preserves any existing scale filter.
	// Without this, multi-profile transcodes would output at source resolution
	// instead of the profile's target resolution.
	if scaleFilter != "" {
		return []string{
			"-filter_complex",
			fmt.Sprintf("[0:v]%s[scaled];[scaled][0:%d]overlay", scaleFilter, streamIndex),
		}
	}
	// No scale (e.g., remux or source-resolution profile)
	return []string{
		"-filter_complex",
		fmt.Sprintf("[0:v][0:%d]overlay", streamIndex),
	}
}

// IsBitmapSubtitle returns true if the codec is a bitmap-based subtitle format.
func IsBitmapSubtitle(codec string) bool {
	switch strings.ToLower(codec) {
	case "hdmv_pgs_subtitle", "pgssub", "pgs",
		"dvd_subtitle", "dvdsub", "vobsub",
		"dvb_subtitle", "dvbsub",
		"xsub":
		return true
	}
	return false
}

// escapeFFmpegPath escapes special characters in file paths for FFmpeg filter syntax.
// FFmpeg's subtitle/overlay filters parse these characters as filter syntax unless escaped.
func escapeFFmpegPath(path string) string {
	// Order matters: escape backslash first so we don't double-escape later replacements
	path = strings.ReplaceAll(path, "\\", "\\\\")
	path = strings.ReplaceAll(path, ":", "\\:")
	path = strings.ReplaceAll(path, "'", "'\\''")
	path = strings.ReplaceAll(path, "[", "\\[")
	path = strings.ReplaceAll(path, "]", "\\]")
	path = strings.ReplaceAll(path, ";", "\\;") // Filter chain separator
	path = strings.ReplaceAll(path, "=", "\\=") // Key-value separator
	path = strings.ReplaceAll(path, ",", "\\,") // Filter graph separator
	return path
}
