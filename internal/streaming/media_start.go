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
// asked for: cast receivers and older clients key off it, and the subtitle
// endpoint still predicts from it when a client sends no measured start).
// What this adds is the measured origin, published in the variant playlist as
// an HLS COMMENT line:
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
	// mediaStartMaxLagSec bounds how far BEFORE start_sec it may sit. A remux
	// begins at the key frame before the anchor, or (the Matroska heuristic)
	// the one before that; two GOPs past a minute is not a real stream. The
	// SPA applies the same window (lib/mediaStart.ts MEDIA_START_MAX_LAG_SEC).
	mediaStartMaxLagSec = 60.0
	// mediaStartBudget bounds the whole measurement, retries included. The
	// first variant playlist request waits for it (the only moment the web
	// player can still adopt the result before showing a frame), so it is
	// what a remux start pays at worst; a healthy probe takes tens of ms.
	mediaStartBudget = 2500 * time.Millisecond
	// mediaStartMaxAttempts caps probes per session. All of them run inside
	// mediaStartBudget, i.e. within the first playlist request: a start that
	// appeared on a LATER reload would move the web player's clock under a
	// viewer already watching, which is worse than never publishing one.
	mediaStartMaxAttempts = 3
	// mediaStartProbeSize and mediaStartAnalyzeDuration keep each probe to the
	// head of the segment: the start time comes from the first packets of
	// each stream (fMP4: from the fragment's trun), and the default 5 MB/5 s
	// would read most of a 4K remux segment for nothing. Measured: the same
	// start time at 32 KB on every fixture; 1 MB leaves room for a key frame
	// of a high-bitrate source ahead of the first audio packet.
	mediaStartProbeSize       = "1000000"
	mediaStartAnalyzeDuration = "1000000"
)

// mediaStartRetryBackoff is the pause before each retry, inside the budget.
var mediaStartRetryBackoff = []time.Duration{150 * time.Millisecond, 400 * time.Millisecond}

// mediaStartState is a session's one measurement, run once in the
// background and awaited by playlist requests.
//
// No request holds a lock across the probe: the first remux playlist request
// starts it, and every request (that one included) waits on `done` for at
// most the budget or until its own context ends. Concurrent fetches wait
// together rather than in turn, and a hung ffprobe costs each of them the
// budget, not a probe timeout per request ahead of it.
//
// The first segment is immutable once the playlist lists it, so the result
// holds for the session's life, including after crash/reap resumes, which
// append to the same playlist rather than rewriting segment 0.
type mediaStartState struct {
	mu      sync.Mutex
	started bool
	done    chan struct{} // closed once sec/known are final
	sec     float64
	known   bool // sec is a plausible measurement to publish
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
//
// It does not take the API's ffprobeGate (internal/api, which imports this
// package): it runs at most mediaStartMaxAttempts times per remux session,
// bounded by mediaStartBudget and the probe limits above, off every lock.
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
	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error",
		"-probesize", mediaStartProbeSize,
		"-analyzeduration", mediaStartAnalyzeDuration,
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

// mediaStartPlausible is the window a measured start must fall in to be
// published for this anchor: [start_sec - 60 s, start_sec + 1 s], never < 0.
func mediaStartPlausible(sec float64, startSec int) bool {
	anchor := float64(startSec)
	return sec >= 0 && sec >= anchor-mediaStartMaxLagSec && sec <= anchor+mediaStartMaxLeadSec
}

// ParseClientMediaStart reads a media start a client sends back: the value of
// this session's #AURORA-MEDIA-START line, which the subtitle endpoint takes
// as media_start= so the cue shift lands where the remux really began rather
// than where ProbeSeekKeyframe predicts it did. Accepted only as a plain
// decimal number of seconds (what the line carries and the web player sends:
// no sign, exponent, NaN or Inf) inside the window the line is published
// under for this start_sec; anything else is ok=false, and the caller keeps
// its prediction.
func ParseClientMediaStart(raw string, startSec int) (float64, bool) {
	if !isDecimalSeconds(raw) {
		return 0, false
	}
	// The shape check already excludes NaN and Inf; an out-of-range decimal
	// is an error here, and anything huge falls outside the window anyway.
	sec, err := strconv.ParseFloat(raw, 64)
	if err != nil || !mediaStartPlausible(sec, startSec) {
		return 0, false
	}
	return sec, true
}

// isDecimalSeconds reports whether s is digits with an optional fractional
// part: `\d+(\.\d+)?`, the shape the SPA's parser accepts too.
func isDecimalSeconds(s string) bool {
	intDigits, fracDigits, sawDot := 0, 0, false
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c >= '0' && c <= '9':
			if sawDot {
				fracDigits++
			} else {
				intDigits++
			}
		case c == '.' && !sawDot:
			sawDot = true
		default:
			return false
		}
	}
	return intDigits > 0 && (!sawDot || fracDigits > 0)
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
// measurement starts only while that is segment 0: that is the segment
// hls.js anchors the session's timeline on. (The unreadable-playlist resume
// fallback rewrites the playlist from a later segment; a session that never
// served segment 0 publishes nothing. A measurement already taken keeps
// being published, because the timeline it describes was fixed by the first
// load — CLAUDE.md records that as a known gap.)
//
// ctx is the request's: it ends this request's wait, never the measurement,
// whose result every later request of the session shares.
func (tm *TranscodeManager) sessionMediaStart(ctx context.Context, s *TranscodeSession, v *QualityVariant, firstSegment string) (float64, bool) {
	if s == nil || v == nil || !s.Remux || s.StartSec <= 0 {
		return 0, false
	}
	st := &s.mediaStart
	st.mu.Lock()
	if !st.started {
		if numStr, ok := segmentNumberPart(firstSegment); !ok || strings.TrimLeft(numStr, "0") != "" {
			st.mu.Unlock()
			return 0, false
		}
		st.started = true
		st.done = make(chan struct{})
		go tm.measureMediaStart(s, v.OutputDir)
	}
	done := st.done
	st.mu.Unlock()

	wait := time.NewTimer(mediaStartBudget + 250*time.Millisecond)
	defer wait.Stop()
	select {
	case <-done:
	case <-ctx.Done():
		return 0, false
	case <-wait.C:
		return 0, false
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.sec, st.known
}

// measureMediaStart runs the session's probes, retrying transient failures
// inside mediaStartBudget, and publishes the outcome by closing done.
func (tm *TranscodeManager) measureMediaStart(s *TranscodeSession, variantDir string) {
	st := &s.mediaStart
	sec, known := 0.0, false
	defer func() {
		st.mu.Lock()
		st.sec, st.known = sec, known
		close(st.done)
		st.mu.Unlock()
	}()
	probe := tm.mediaStartProbe
	if probe == nil {
		probe = probeMediaStartSec
	}
	ctx, cancel := context.WithTimeout(context.Background(), mediaStartBudget)
	defer cancel()
	for attempt := 1; attempt <= mediaStartMaxAttempts; attempt++ {
		measured, err := probe(ctx, variantDir, s.FMP4)
		if err == nil {
			if !mediaStartPlausible(measured, s.StartSec) {
				slog.Warn("remux media start implausible for its anchor; not publishing it",
					"session_id", s.ID, "start_sec", s.StartSec, "measured_sec", measured)
				return
			}
			sec, known = measured, true
			slog.Info("remux media start measured",
				"session_id", s.ID, "start_sec", s.StartSec, "media_start_sec", fmt.Sprintf("%.3f", sec),
				"keyframe_gap_sec", fmt.Sprintf("%.3f", float64(s.StartSec)-sec), "attempt", attempt)
			return
		}
		slog.Warn("remux media start probe failed",
			"session_id", s.ID, "start_sec", s.StartSec, "attempt", attempt, "error", err)
		if attempt > len(mediaStartRetryBackoff) {
			break
		}
		retry := time.NewTimer(mediaStartRetryBackoff[attempt-1])
		select {
		case <-ctx.Done():
		case <-retry.C:
		}
		retry.Stop()
		if ctx.Err() != nil {
			break
		}
	}
	slog.Warn("remux media start not measured; clients keep start_sec",
		"session_id", s.ID, "start_sec", s.StartSec)
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
