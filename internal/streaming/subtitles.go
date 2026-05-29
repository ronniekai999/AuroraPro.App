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
	"strconv"
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

// ProbeSeekKeyframe returns the video keyframe timestamp (seconds) that
// ffmpeg's input seek (`-ss <target>` before `-i`) will land on for the
// given file — i.e. the largest keyframe PTS that is <= target.
//
// Why this matters (Issue #141): input seek can only start a stream at a
// keyframe, so it rounds the requested resume position DOWN to the
// nearest preceding keyframe. With -copyts/-start_at_zero that keyframe
// becomes the HLS stream's t=0. The subtitle cue-shift must use this
// keyframe time, not the requested target, or every cue lands up to one
// GOP early ("subtitles ahead of audio").
//
// On any probe failure (no video stream, ffprobe missing, parse error)
// it returns the target unchanged: callers then shift by the requested
// position, which is the pre-#141 behavior — slightly off, but never
// worse than before, and never blocks subtitle serving. Failures are
// swallowed deliberately (no error return) because there is no caller
// action that differs from the fallback.
//
// Known limitation (open-GOP H.264): `-skip_frame nokey` reports ALL
// I-frames, but ffmpeg's input seek lands on the seekable IDR. If a
// non-IDR I-frame sits between the IDR and target, this returns the
// closer non-IDR frame, shifting cues by up to the IDR↔I gap (sub-GOP,
// ~1-2s) in the SAFE direction (cues slightly late, not early). Most
// remux-tier content is closed-GOP/all-IDR so this rarely bites; the
// error is still smaller than the pre-#141 full-GOP error.
func ProbeSeekKeyframe(ctx context.Context, filePath string, target float64) float64 {
	if target <= 0 {
		return target
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	// Read a window ending just past the target. A 16s window
	// comfortably exceeds any sane GOP (typically 2-10s).
	// -skip_frame nokey makes the decoder emit ONLY keyframes, so the
	// output is the set of keyframes in [keyframe<=from, ~target]. We
	// then take the max keyframe <= target.
	from := target - 16
	if from < 0 {
		from = 0
	}
	// `start%end` interval form. Read slightly past the target so a
	// keyframe sitting right at the boundary is included in the scan;
	// the strict filter below (kfMatchEpsilon) decides which ones
	// actually count.
	interval := fmt.Sprintf("%.3f%%%.3f", from, target+0.5)

	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-select_streams", "v:0",
		"-skip_frame", "nokey",
		"-read_intervals", interval,
		"-show_entries", "frame=pts_time,best_effort_timestamp_time",
		"-print_format", "json",
		filePath,
	)
	out, err := cmd.Output()
	if err != nil {
		return target // probe failed → fall back to requested target
	}

	var probe struct {
		Frames []struct {
			PTSTime    string `json:"pts_time"`
			BestEffort string `json:"best_effort_timestamp_time"`
		} `json:"frames"`
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		return target
	}

	// ffmpeg's input seek lands on the largest keyframe with PTS <=
	// target. The epsilon ONLY absorbs float-print jitter for a
	// keyframe that is nominally AT the target (e.g. prints as
	// 9.999983 or 10.000017) — it must NOT be wide enough to admit
	// the next GOP's keyframe, or we'd shift cues the wrong way and
	// push subtitles slightly BEHIND the audio. 2ms is comfortably
	// below any real GOP gap.
	const kfMatchEpsilon = 0.002
	best := -1.0
	for _, f := range probe.Frames {
		// Prefer pts_time; fall back to best_effort when pts_time is
		// "N/A" (some containers).
		ts := f.PTSTime
		if ts == "" || ts == "N/A" {
			ts = f.BestEffort
		}
		v, perr := strconv.ParseFloat(ts, 64)
		if perr != nil {
			continue
		}
		if v <= target+kfMatchEpsilon && v > best {
			best = v
		}
	}
	if best < 0 {
		// No keyframe found in the window — shouldn't happen (the
		// window starts before target), but fall back safely.
		return target
	}
	return best
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

// vttTimestampRE matches WebVTT cue timestamps. Format spec:
//
//	HH:MM:SS.fff    (e.g. 01:23:45.678)
//	MM:SS.fff       (e.g. 23:45.678)
//
// Captures: 1=full timestamp, 2=hh (optional), 3=mm, 4=ss, 5=fff.
var vttTimestampRE = regexp.MustCompile(`(?:(\d{1,3}):)?(\d{1,2}):(\d{2})\.(\d{3})`)

// vttCueLineRE matches the timing line of a VTT cue:
//
//	<start> --> <end> [cue settings…]
//
// We rewrite both timestamps and preserve everything after the second
// timestamp (cue position/align settings, if any).
var vttCueLineRE = regexp.MustCompile(`^((?:\d{1,3}:)?\d{1,2}:\d{2}\.\d{3})\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}\.\d{3})(.*)$`)

// parseVTTTimestamp converts a VTT timestamp string to seconds (float).
// Returns -1 on parse failure.
func parseVTTTimestamp(ts string) float64 {
	m := vttTimestampRE.FindStringSubmatch(ts)
	if m == nil {
		return -1
	}
	var hh, mm, ss, fff int
	if m[1] != "" {
		hh, _ = strconv.Atoi(m[1])
	}
	mm, _ = strconv.Atoi(m[2])
	ss, _ = strconv.Atoi(m[3])
	fff, _ = strconv.Atoi(m[4])
	return float64(hh*3600+mm*60+ss) + float64(fff)/1000.0
}

// formatVTTTimestamp renders seconds (float) as a VTT timestamp.
// Always emits HH:MM:SS.fff for consistency.
func formatVTTTimestamp(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	hh := int(sec / 3600)
	rem := sec - float64(hh*3600)
	mm := int(rem / 60)
	rem -= float64(mm * 60)
	ss := int(rem)
	fff := int((rem - float64(ss)) * 1000.0)
	return fmt.Sprintf("%02d:%02d:%02d.%03d", hh, mm, ss, fff)
}

// ShiftVTTCues reads vttPath and writes a NEW VTT file with every cue
// timestamp shifted by -offsetSec seconds. Cues that become fully
// negative (end < 0 after the shift) are dropped — they're already
// "in the past" relative to the resume point. Cues that straddle zero
// (start < 0 < end) are clamped: start := 0, end stays.
//
// The output is cached at <cacheDir>/<hash>_shift<offset>.vtt. If
// offsetSec <= 0, returns vttPath unchanged (no shift needed).
//
// This exists because the HLS transcode uses -ss to seek the input,
// so the player's currentTime=0 corresponds to file-time=offsetSec.
// Sidecar VTT cues use ORIGINAL file timestamps, so without the shift
// every cue would fire at the wrong moment (or never, if past EOF).
// Reported as Aurora Issue #131 (subtitles invisible after resume).
//
// 2026-05-28 (Issue #141) — offsetSec is now a float64 and MUST be the
// actual keyframe time the player's t=0 maps to, NOT the requested
// resume position. `-ss <startSec>` placed before `-i` is an INPUT
// seek: ffmpeg lands on the nearest keyframe ≤ startSec, and
// -copyts/-start_at_zero make THAT keyframe the HLS t=0. Shifting by
// the raw startSec (which can be up to one GOP after the keyframe)
// placed every cue ~2-3s too early — "subtitles ahead of audio".
// Callers must pass ProbeSeekKeyframe(startSec), not startSec.
func ShiftVTTCues(vttPath string, offsetSec float64, cacheDir string) (string, error) {
	if offsetSec <= 0 {
		return vttPath, nil
	}
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		return "", fmt.Errorf("create vtt-shift cache dir: %w", err)
	}
	src, err := os.Open(vttPath)
	if err != nil {
		return "", fmt.Errorf("open vtt source: %w", err)
	}
	defer src.Close()
	srcInfo, err := src.Stat()
	if err != nil {
		return "", fmt.Errorf("stat vtt source: %w", err)
	}

	// Cache key: hash of (vttPath, offset rounded to ms). Keep the
	// source filename stem so the cached file is debuggable on disk.
	// Round to milliseconds for the key so float jitter from the
	// keyframe probe doesn't fragment the cache.
	offsetMs := int64(offsetSec*1000 + 0.5)
	h := sha256.Sum256([]byte(fmt.Sprintf("%s|%d", vttPath, offsetMs)))
	stem := strings.TrimSuffix(filepath.Base(vttPath), filepath.Ext(vttPath))
	outPath := filepath.Join(cacheDir, fmt.Sprintf("%s_shift%dms_%x.vtt", stem, offsetMs, h[:6]))

	// Cache hit: existing shifted file newer than the source.
	if outInfo, err := os.Stat(outPath); err == nil && outInfo.Size() > 0 && outInfo.ModTime().After(srcInfo.ModTime()) {
		return outPath, nil
	}

	dst, err := os.Create(outPath)
	if err != nil {
		return "", fmt.Errorf("create shifted vtt: %w", err)
	}
	defer dst.Close()

	bw := bufio.NewWriter(dst)
	defer bw.Flush()

	scanner := bufio.NewScanner(src)
	// Bump the scanner buffer for long cue lines. Default 64K is fine
	// for normal subs but some ASS-converted VTTs have multi-line
	// settings strings.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	// Read the whole VTT into memory and process in BLOCK mode. Block
	// mode is necessary because:
	//   - STYLE / NOTE / REGION blocks can span many lines and must be
	//     preserved verbatim (any content inside may be CSS-like and
	//     may even contain text that *looks* like a timing line).
	//   - Cue blocks have an optional first-line id; the timing line
	//     is the second non-blank line.
	//
	// VTT spec: blocks are separated by one or more blank lines. The
	// FIRST block must be the WEBVTT header. Subsequent blocks are
	// classified by their first non-blank line:
	//   - starts with "STYLE"  → STYLE block (verbatim)
	//   - starts with "NOTE"   → NOTE block  (verbatim)
	//   - starts with "REGION" → REGION block (verbatim)
	//   - contains "-->" on first or second line → cue block
	//   - anything else → unknown, pass through verbatim
	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		os.Remove(outPath)
		return "", fmt.Errorf("read vtt: %w", err)
	}

	startOffset := offsetSec

	// emitBlock writes a slice of lines + a trailing blank-line
	// separator (the block boundary). Empty blocks are skipped.
	emitBlock := func(block []string) {
		if len(block) == 0 {
			return
		}
		for _, l := range block {
			bw.WriteString(l + "\n")
		}
		bw.WriteString("\n")
	}

	// Group input into blocks (slices of lines) separated by blank
	// lines. Multiple consecutive blanks collapse into one separator.
	var blocks [][]string
	var cur []string
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			if len(cur) > 0 {
				blocks = append(blocks, cur)
				cur = nil
			}
			continue
		}
		cur = append(cur, l)
	}
	if len(cur) > 0 {
		blocks = append(blocks, cur)
	}

	// Process each block.
	for bi, block := range blocks {
		// The first block is the WEBVTT header. Emit verbatim.
		if bi == 0 {
			emitBlock(block)
			continue
		}
		first := strings.TrimSpace(block[0])
		// STYLE / NOTE / REGION blocks: verbatim passthrough.
		if first == "STYLE" || strings.HasPrefix(first, "STYLE ") ||
			first == "NOTE" || strings.HasPrefix(first, "NOTE ") ||
			first == "REGION" || strings.HasPrefix(first, "REGION ") {
			emitBlock(block)
			continue
		}
		// Identify the timing line: first line in the block that
		// matches vttCueLineRE. If line 0 is the timing line, there's
		// no cue id. If line 1 is the timing line, line 0 is the id.
		// If no timing line matches, this isn't a cue — pass through.
		timingIdx := -1
		var timingMatch []string
		for li, l := range block {
			if m := vttCueLineRE.FindStringSubmatch(l); m != nil {
				timingIdx = li
				timingMatch = m
				break
			}
		}
		if timingIdx < 0 {
			// Not a recognizable cue block — pass through verbatim
			// (defensive against unusual VTT extensions).
			emitBlock(block)
			continue
		}
		startT := parseVTTTimestamp(timingMatch[1])
		endT := parseVTTTimestamp(timingMatch[2])
		if startT < 0 || endT < 0 {
			// Timing parse failed — pass through verbatim.
			emitBlock(block)
			continue
		}
		shiftedStart := startT - startOffset
		shiftedEnd := endT - startOffset
		if shiftedEnd <= 0 {
			// Entire cue is in the past — drop the whole block (id +
			// timing + text).
			continue
		}
		if shiftedStart < 0 {
			shiftedStart = 0
		}
		// Settings tail (cue position/alignment) — keep as-is.
		settings := timingMatch[3]
		// Ensure exactly one space between end-timestamp and settings
		// when settings is non-empty and doesn't already start with
		// whitespace. Source files always have it, but be defensive
		// (Deep-debug S3).
		if settings != "" && !strings.HasPrefix(settings, " ") && !strings.HasPrefix(settings, "\t") {
			settings = " " + settings
		}
		newTiming := fmt.Sprintf("%s --> %s%s",
			formatVTTTimestamp(shiftedStart),
			formatVTTTimestamp(shiftedEnd),
			settings,
		)
		// Rebuild the block: cue-id lines (if any) + new timing +
		// rest of the cue text body.
		rebuilt := make([]string, 0, len(block))
		rebuilt = append(rebuilt, block[:timingIdx]...)
		rebuilt = append(rebuilt, newTiming)
		rebuilt = append(rebuilt, block[timingIdx+1:]...)
		emitBlock(rebuilt)
	}
	return outPath, nil
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

// SubtitleRelativeIndex translates an ABSOLUTE ffprobe stream index into the
// SUBTITLE-RELATIVE index that FFmpeg's `subtitles` filter expects in its
// stream_index option.
//
// Audit MED — the `subtitles` filter's stream_index is counted ONLY over the
// file's subtitle streams (0 = first subtitle stream, 1 = second, …), NOT over
// all streams. Passing the absolute index (e.g. stream 2 in a video+audio+sub
// file) makes the filter try to read the 3rd subtitle stream, which usually
// doesn't exist — burn-in then fails or silently picks the wrong track.
//
// tracks must be the file's subtitle tracks as returned by ProbeSubtitles
// (ordered by appearance in the container). The position of the track whose
// .Index == absoluteIndex is the relative index. If no track matches (probe
// empty, stale index, or probe failure), we return absoluteIndex unchanged —
// the pre-fix behavior, which is never worse than before and avoids breaking
// burn-in entirely on a probe hiccup.
func SubtitleRelativeIndex(tracks []models.SubtitleTrack, absoluteIndex int) int {
	for rel, t := range tracks {
		if t.Index == absoluteIndex {
			return rel
		}
	}
	return absoluteIndex
}

// BurnInArgs returns FFmpeg filter arguments to burn subtitles into the video stream.
// For embedded subs, streamIndex is the ABSOLUTE ffprobe stream index within the
// container; it is translated to the subtitle-relative index the `subtitles`
// filter requires (audit MED). For external subs, externalPath is the path to
// the .srt/.ass/.ssa file.
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

	// Embedded subtitle — reference the input file and stream index. The
	// `subtitles` filter's stream_index is subtitle-relative, so probe the
	// file's subtitle streams and map the absolute index across. On any probe
	// failure ProbeSubtitles returns no tracks and SubtitleRelativeIndex falls
	// back to the absolute index (pre-fix behavior).
	relIndex := streamIndex
	if tracks, _ := ProbeSubtitles(context.Background(), mediaPath); len(tracks) > 0 {
		relIndex = SubtitleRelativeIndex(tracks, streamIndex)
	}
	escaped := escapeFFmpegPath(mediaPath)
	return []string{"-vf", fmt.Sprintf("subtitles=%s:stream_index=%d", escaped, relIndex)}
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
//
// Issue #135 — extended the list defensively. FFmpeg's codec_name for the
// same source can vary by version; we want to catch every variant so the
// frontend bitmap filter doesn't leak through and the ServeSubtitle 400
// guard fires the moment a bitmap track is requested. If a new codec
// variant slips through, the new subtitle-served slog.Info will reveal it.
func IsBitmapSubtitle(codec string) bool {
	switch strings.ToLower(codec) {
	// PGS (Blu-ray): hdmv_pgs_subtitle (modern), pgssub (older), pgs (alias)
	case "hdmv_pgs_subtitle", "pgssub", "pgs", "pgs_subtitle":
		return true
	// VobSub (DVD)
	case "dvd_subtitle", "dvdsub", "vobsub":
		return true
	// DVB (broadcast)
	case "dvb_subtitle", "dvbsub":
		return true
	// xsub (DivX bitmap subs)
	case "xsub":
		return true
	// hdmv_text_subtitle is text-based per name but FFmpeg's webvtt
	// converter rejects it as "unsupported source codec" — treat as
	// bitmap to keep it out of the picker until we add a real converter.
	case "hdmv_text_subtitle":
		return true
	}
	return false
}

// IsTextSubtitle returns true if the codec is a text-based subtitle format
// that we know FFmpeg can convert to WebVTT cleanly. Used as a SECONDARY
// check by the frontend so an unrecognized codec name (neither in the
// bitmap list nor here) is shown to the user with a "may not work"
// indicator instead of silently failing.
//
// Issue #135 — added because Elf's "eng" subrip should obviously work but
// didn't, and we want the picker to tell the user "this should work" vs
// "this is unknown territory" so future bug reports include the codec
// name in the user's complaint.
func IsTextSubtitle(codec string) bool {
	switch strings.ToLower(codec) {
	case "subrip", "srt",
		"ass", "ssa",
		"webvtt", "vtt",
		"mov_text",
		"text", "subviewer", "subviewer1",
		"eia_608", "eia_708",
		"microdvd":
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
