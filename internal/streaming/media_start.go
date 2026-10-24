package streaming

// Where a remux session's media actually begins.
//
// A remux seeks with -ss <start_sec> -noaccurate_seek, so its first segment
// starts at the key frame BEFORE start_sec (on Matroska with B-frames the
// demuxer's 130 ms dts heuristic can land one whole GOP earlier still), and
// players map that first sample to media time 0. Anything that treats media
// time 0 as start_sec reads high by the gap to that key frame — up to a GOP,
// ~10 s on a 10 s GOP. Measured in Chromium through the bundled hls.js: a
// session asked for 25 s on a 10 s-GOP file showed 20.0 s at media time 0,
// and one asked for 40 s on the Matroska copy showed 30.0 s.
//
// start_sec stays what it is (the whole-second -ss anchor the session was
// asked for: the subtitle cue shift, cast receivers and older clients all key
// off it). What this adds is the measured origin, published in the variant
// playlist as an HLS COMMENT line:
//
//	#AURORA-MEDIA-START:19.946009
//
// RFC 8216 §4.1: lines starting with '#' that are not tags (#EXT…) are
// comments, so Safari, AVPlayer, ExoPlayer, Shaka and FFmpeg ignore it, while
// hls.js hands it to the web player in the first fragment's tagList (it sits
// right before the first #EXTINF; see insertBeforeFirstSegment for why). A
// playlist rather than a JSON field because the origin does not exist until
// FFmpeg has written its first segment, which is after the session-create
// response and before the first variant playlist can be served.
//
// Why measure rather than predict: ProbeSeekKeyframe models FFmpeg's input
// seek as "the greatest key frame <= target", which the Matroska heuristic
// above makes wrong by a whole GOP whenever the target sits within 130 ms
// after a key frame — the one case where the error is largest.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// mediaStartTagPrefix is the variant-playlist comment carrying the measured
// origin. The SPA's lib/mediaStart.ts reads the same name; change both or
// neither.
const mediaStartTagPrefix = "#AURORA-MEDIA-START:"

const (
	// mediaStartMaxLeadSec bounds how far AFTER start_sec a measured origin
	// may sit and still be published. -noaccurate_seek only ever lands at or
	// before the anchor; the slack covers the first sample's B-frame/codec
	// delay. Anything later did not come from this anchor.
	mediaStartMaxLeadSec = 1.0
	// mediaStartProbeTimeout bounds the one ffprobe a session pays. It reads
	// headers and the first packets of a segment already on disk.
	mediaStartProbeTimeout = 10 * time.Second
	// mediaStartMaxAttempts caps retries after transient probe failures, so
	// a segment ffprobe cannot read costs a few probes, not one per playlist
	// reload for the life of the session.
	mediaStartMaxAttempts = 3
)

// mediaStartState caches a session's measured origin. The first segment is
// immutable once the playlist lists it, so one successful measurement holds
// for the session's life, including after crash/reap resumes, which append
// to the same playlist rather than rewriting segment 0.
type mediaStartState struct {
	mu       sync.Mutex
	sec      float64
	known    bool // sec holds a published measurement
	settled  bool // no further probe will be attempted (known, or unusable)
	attempts int
}

// errNoMediaStart reports a segment that carries no usable start time.
var errNoMediaStart = errors.New("first segment has no start time")

// probeMediaStartSec measures where a variant's first segment begins on the
// session's source clock: the earliest presentation time ffprobe reports for
// seg_00000 (prefixed with init.mp4 for fMP4, which a CMAF fragment needs to
// be readable at all — the edit list carrying the offset lives there).
//
// The output keeps the source clock because every variant runs under
// -copyts -start_at_zero, so its timestamps are -ss coordinates. The figure
// is within a couple of frames of the player's media-time origin (hls.js
// zeroes on the first decode time of the track it syncs on; ffprobe reports
// the earliest presentation time across streams): 6-18 ms on the Chromium
// measurement, against errors of a whole GOP without it.
func probeMediaStartSec(ctx context.Context, variantDir string, fmp4 bool) (float64, error) {
	var input string
	if fmp4 {
		initPath := filepath.Join(variantDir, "init.mp4")
		segPath := filepath.Join(variantDir, "seg_00000.m4s")
		// The concat protocol splits its list on '|'. A transcode directory
		// containing one would be read as a different list; refuse instead.
		if strings.ContainsRune(initPath, '|') || strings.ContainsRune(segPath, '|') {
			return 0, fmt.Errorf("segment path contains '|': %s", variantDir)
		}
		input = "concat:" + initPath + "|" + segPath
	} else {
		input = filepath.Join(variantDir, "seg_00000.ts")
	}
	ctx, cancel := context.WithTimeout(ctx, mediaStartProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error",
		"-show_entries", "format=start_time",
		"-of", "default=noprint_wrappers=1:nokey=1",
		input)
	out, err := boundedOutput(cmd)
	if err != nil {
		return 0, fmt.Errorf("ffprobe first segment: %w", err)
	}
	raw := strings.TrimSpace(string(out))
	if raw == "" || raw == "N/A" {
		return 0, errNoMediaStart
	}
	sec, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(sec) || math.IsInf(sec, 0) {
		return 0, fmt.Errorf("%w: %q", errNoMediaStart, raw)
	}
	return sec, nil
}

// sessionMediaStart returns the measured origin to publish for this session,
// or ok=false to publish nothing (the client then keeps start_sec, which is
// exactly the pre-measurement behaviour).
//
// Only a remux started mid-file gets one. A transcode seeks accurately, so
// its media time 0 IS start_sec and its clock must not move; a remux from 0
// passes no -ss at all.
//
// firstSegment is the first media URI the playlist being served lists. The
// measurement is taken only while that is segment 0: that is the segment
// hls.js anchors the session's timeline on. (The unreadable-playlist resume
// fallback rewrites the playlist from a later segment; a session that never
// served segment 0 publishes nothing. A cached measurement keeps being
// published, because the timeline it describes was fixed by the first load.)
func (tm *TranscodeManager) sessionMediaStart(s *TranscodeSession, v *QualityVariant, firstSegment string) (float64, bool) {
	if s == nil || v == nil || !s.Remux || s.StartSec <= 0 {
		return 0, false
	}
	st := &s.mediaStart
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.settled {
		return st.sec, st.known
	}
	if numStr, ok := segmentNumberPart(firstSegment); !ok || strings.TrimLeft(numStr, "0") != "" {
		return 0, false
	}
	if st.attempts >= mediaStartMaxAttempts {
		st.settled = true
		return 0, false
	}
	st.attempts++
	probe := tm.mediaStartProbe
	if probe == nil {
		probe = probeMediaStartSec
	}
	// Deliberately not the request's context: an impatient client cancelling
	// its playlist fetch must not spend one of the session's few attempts.
	sec, err := probe(context.Background(), v.OutputDir, s.FMP4)
	if err != nil {
		slog.Warn("remux media start not measured; clients keep start_sec",
			"session_id", s.ID, "start_sec", s.StartSec, "attempt", st.attempts, "error", err)
		return 0, false
	}
	st.settled = true
	if sec < 0 || sec > float64(s.StartSec)+mediaStartMaxLeadSec {
		slog.Warn("remux media start implausible for its anchor; not publishing it",
			"session_id", s.ID, "start_sec", s.StartSec, "measured_sec", sec)
		return 0, false
	}
	st.sec, st.known = sec, true
	slog.Info("remux media start measured",
		"session_id", s.ID, "start_sec", s.StartSec, "media_start_sec", fmt.Sprintf("%.3f", sec),
		"keyframe_gap_sec", fmt.Sprintf("%.3f", float64(s.StartSec)-sec))
	return sec, true
}

// mediaStartLine renders the playlist comment for a measured origin.
func mediaStartLine(sec float64) string {
	return mediaStartTagPrefix + strconv.FormatFloat(sec, 'f', 6, 64)
}

// insertBeforeFirstSegment places line immediately before the first #EXTINF,
// i.e. among the first media segment's own tags. Not in the header: hls.js
// turns the header's tag list into the INIT segment's when #EXT-X-MAP
// follows (every fMP4 playlist), and the web player reads the first media
// fragment's. Measured in Chromium: a header comment never reached
// fragments[0] on fMP4. A playlist with no segment is returned unchanged.
func insertBeforeFirstSegment(lines []string, line string) []string {
	for i, l := range lines {
		if strings.HasPrefix(l, "#EXTINF") {
			out := make([]string, 0, len(lines)+1)
			out = append(out, lines[:i]...)
			out = append(out, line)
			return append(out, lines[i:]...)
		}
	}
	return lines
}

// firstMediaURI returns the first segment URI a playlist lists, or "".
func firstMediaURI(lines []string) string {
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		return line
	}
	return ""
}
