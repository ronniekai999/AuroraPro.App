package streaming

// Tests for the 2026-06 streaming-review fixes: per-user session quota (S1),
// the idle variant reaper + reap-resume (P1), fMP4 segment support (M1),
// the static-fallback remux policy (B3), and the small helpers behind them.

import (
	"errors"
	"fmt"
	"math"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
)

// aacLikeTracks builds a single default audio track with the given codec.
func aacLikeTracks(codec string) []models.AudioTrack {
	return []models.AudioTrack{{Codec: codec, Channels: 2, IsDefault: true}}
}

func TestEffectiveMaxSessionsPerUser(t *testing.T) {
	tests := []struct {
		configured int
		want       int
	}{
		{0, defaultMaxSessionsPerUser},
		{-1, defaultMaxSessionsPerUser},
		{1, 1},
		{5, 5},
	}
	for _, tt := range tests {
		if got := effectiveMaxSessionsPerUser(tt.configured); got != tt.want {
			t.Errorf("effectiveMaxSessionsPerUser(%d) = %d, want %d", tt.configured, got, tt.want)
		}
	}
	if defaultMaxSessionsPerUser <= 0 {
		t.Fatalf("defaultMaxSessionsPerUser must be > 0, got %d", defaultMaxSessionsPerUser)
	}
}

func TestFFmpegMajorVersion(t *testing.T) {
	tests := []struct {
		banner string
		want   int
	}{
		{"ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023", 6},
		{"ffmpeg version 5.0 Copyright", 5},
		{"ffmpeg version n5.1.4 Copyright", 5}, // release-tag form
		{"ffmpeg version 4.4.2-0ubuntu0.22.04.1", 4},
		{"ffmpeg version 10.0", 10},
		{"ffmpeg version N-109983-g4d216654ca", 0}, // git snapshot: unknown
		{"garbage", 0},
		{"", 0},
	}
	for _, tt := range tests {
		if got := ffmpegMajorVersion(tt.banner); got != tt.want {
			t.Errorf("ffmpegMajorVersion(%q) = %d, want %d", tt.banner, got, tt.want)
		}
	}
}

func TestSegmentNumberPart(t *testing.T) {
	tests := []struct {
		name   string
		want   string
		wantOK bool
	}{
		{"seg_00042.ts", "00042", true},
		{"seg_00042.m4s", "00042", true},
		{"seg_0.ts", "0", true},
		{"init.mp4", "", false},
		{"stream.m3u8", "", false},
		{"seg_00042.tmp", "", false},
		{"other_00042.ts", "", false},
	}
	for _, tt := range tests {
		got, ok := segmentNumberPart(tt.name)
		if got != tt.want || ok != tt.wantOK {
			t.Errorf("segmentNumberPart(%q) = (%q, %v), want (%q, %v)", tt.name, got, ok, tt.want, tt.wantOK)
		}
	}
}

func TestMediaSegmentNameValidation(t *testing.T) {
	valid := []string{"seg_00000.ts", "seg_12345.m4s", "init.mp4"}
	for _, name := range valid {
		if !reMediaSegment.MatchString(name) {
			t.Errorf("reMediaSegment rejected valid name %q", name)
		}
	}
	invalid := []string{
		"../../etc/passwd", "seg_..ts", "seg_1.ts/../x", "seg_1.mp4",
		"init.m4s", "seg_a.ts", "seg_1.ts ", "SEG_1.TS", "init.mp4.bak",
		"subs_0.m3u8",
	}
	for _, name := range invalid {
		if reMediaSegment.MatchString(name) {
			t.Errorf("reMediaSegment accepted invalid name %q", name)
		}
	}
}

// fakeFFmpegOnPath drops an executable stub named ffmpeg into a temp dir and
// prepends it to PATH so CreateSession's exec.LookPath gate passes in
// environments without a real ffmpeg.
func fakeFFmpegOnPath(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	stub := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("write ffmpeg stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestCreateSession_PerUserQuota(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{
		MaxSessions:        10,
		MaxSessionsPerUser: 2,
	})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	for i := 0; i < 2; i++ {
		if _, err := tm.CreateSession(1, "alice", "/tmp/a.mkv", 1920, 1080); err != nil {
			t.Fatalf("session %d for user 1: %v", i, err)
		}
	}
	// Third session for the same user must hit the per-user limit.
	if _, err := tm.CreateSession(1, "alice", "/tmp/b.mkv", 1920, 1080); !errors.Is(err, ErrUserSessionLimit) {
		t.Fatalf("third session for user 1: err = %v, want ErrUserSessionLimit", err)
	}
	// A DIFFERENT user must still be able to create sessions.
	if _, err := tm.CreateSession(2, "bob", "/tmp/c.mkv", 1920, 1080); err != nil {
		t.Fatalf("session for user 2 blocked by user 1's quota: %v", err)
	}
}

// TestCreateSession_RemuxAudioRecodeFallback verifies the segment-format-aware
// remux→transcode promotion. In MPEG-TS mode a remux session with audio
// re-encoding (RemuxAudioCopy=false) is silently promoted to full transcode so
// -force_key_frames can enforce clean segment boundaries and prevent
// native-HLS audio skipping (issue #344). In fMP4/CMAF mode (the default) the
// remux is KEPT: fragments carry explicit baseMediaDecodeTime, so irregular
// video-copy cut points cause no timeline discontinuities — and promoting
// e.g. a 4K HEVC HDR + DTS file to a full-rate video transcode is exactly the
// encoder-can't-keep-up buffering failure the fMP4 path avoids.
func TestCreateSession_RemuxAudioRecodeFallback(t *testing.T) {
	fakeFFmpegOnPath(t)

	tests := []struct {
		name           string
		segmentFormat  string // TranscodeConfig.SegmentFormat ("" = fmp4 default)
		remux          bool
		remuxAudioCopy bool
		forceTS        bool
		wantRemux      bool
	}{
		{
			name:           "fmp4: remux+audio_copy stays remux",
			remux:          true,
			remuxAudioCopy: true,
			wantRemux:      true,
		},
		{
			name:           "fmp4: remux+audio_recode STAYS remux (no promotion)",
			remux:          true,
			remuxAudioCopy: false,
			wantRemux:      true,
		},
		{
			name:           "fmp4: pure transcode unchanged",
			remux:          false,
			remuxAudioCopy: false,
			wantRemux:      false,
		},
		{
			name:           "ts: remux+audio_recode falls back to transcode",
			segmentFormat:  "ts",
			remux:          true,
			remuxAudioCopy: false,
			wantRemux:      false,
		},
		{
			name:           "ts: remux+audio_copy stays remux",
			segmentFormat:  "ts",
			remux:          true,
			remuxAudioCopy: true,
			wantRemux:      true,
		},
		{
			name:           "fmp4 server but ForceTS session: remux+audio_recode falls back to transcode",
			remux:          true,
			remuxAudioCopy: false,
			forceTS:        true,
			wantRemux:      false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: tt.segmentFormat})
			if err != nil {
				t.Fatalf("new transcode manager: %v", err)
			}
			defer tm.Close()

			s, err := tm.CreateSession(1, "alice", "/tmp/a.mkv", 1920, 1080, SessionOpts{
				Remux:          tt.remux,
				RemuxAudioCopy: tt.remuxAudioCopy,
				ForceTS:        tt.forceTS,
			})
			if err != nil {
				t.Fatalf("CreateSession: %v", err)
			}
			if s.Remux != tt.wantRemux {
				t.Errorf("session.Remux = %v, want %v", s.Remux, tt.wantRemux)
			}
			if !s.Remux && len(s.Profiles) > 0 {
				// Transcoding sessions (explicit or promoted) must carry quality
				// params (CRF, bitrate strings) rather than the bare
				// source-resolution stub.
				for _, p := range s.Profiles {
					if p.CRF == 0 && p.VideoBitrate == "" {
						t.Errorf("profile %q has no quality params after transcode promotion", p.Name)
					}
				}
			}
			if s.Remux && tt.remux {
				// Remux sessions must keep the single source-resolution profile —
				// codec copy can't change resolution, so a quality ladder would
				// advertise variants the session can't produce.
				if len(s.Profiles) != 1 || s.Profiles[0].Name != "source" {
					t.Errorf("remux session profiles = %+v, want single 'source' profile", s.Profiles)
				}
			}
		})
	}
}

// TestCreateSession_HDRTonemapRederived pins the SourceHDR contract: any
// session that re-encodes video from an HDR source gets HDRTonemap forced on,
// even when the API layer's stream-info decision said hdr_tonemap=false
// (it only sets the flag when ITS decision was "transcode" — the TS-mode
// remux promotion and client forceTranscode retries arrive here with the
// remux decision's false). Without this, promoted sessions re-encode 10-bit
// PQ frames into washed-out gray 8-bit H.264.
func TestCreateSession_HDRTonemapRederived(t *testing.T) {
	fakeFFmpegOnPath(t)

	tests := []struct {
		name          string
		segmentFormat string
		opts          SessionOpts
		wantRemux     bool
		wantTonemap   bool
	}{
		{
			name:          "ts promotion of HDR remux enables tonemap",
			segmentFormat: "ts",
			opts:          SessionOpts{Remux: true, RemuxAudioCopy: false, SourceHDR: true},
			wantRemux:     false,
			wantTonemap:   true,
		},
		{
			name:          "ts promotion of SDR remux leaves tonemap off",
			segmentFormat: "ts",
			opts:          SessionOpts{Remux: true, RemuxAudioCopy: false, SourceHDR: false},
			wantRemux:     false,
			wantTonemap:   false,
		},
		{
			name: "fmp4 HDR remux keeps video copy and NO tonemap",
			opts: SessionOpts{Remux: true, RemuxAudioCopy: false, SourceHDR: true},
			// Video is copied untouched — the browser receives the original
			// HDR stream; tonemapping is neither needed nor possible (-c:v copy).
			wantRemux:   true,
			wantTonemap: false,
		},
		{
			name: "forced transcode of HDR source enables tonemap (client echoed false)",
			opts: SessionOpts{Remux: false, SourceHDR: true, HDRTonemap: false},
			// The Phase-5 MEDIA_ERROR fallback re-creates the session with
			// remux=false but echoes the remux decision's hdr_tonemap=false.
			wantRemux:   false,
			wantTonemap: true,
		},
		{
			name:        "explicit tonemap request preserved",
			opts:        SessionOpts{Remux: false, SourceHDR: false, HDRTonemap: true},
			wantRemux:   false,
			wantTonemap: true,
		},
		{
			name:        "SDR transcode untouched",
			opts:        SessionOpts{Remux: false, SourceHDR: false},
			wantRemux:   false,
			wantTonemap: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: tt.segmentFormat})
			if err != nil {
				t.Fatalf("new transcode manager: %v", err)
			}
			defer tm.Close()

			s, err := tm.CreateSession(1, "alice", "/tmp/a.mkv", 3840, 2160, tt.opts)
			if err != nil {
				t.Fatalf("CreateSession: %v", err)
			}
			if s.Remux != tt.wantRemux {
				t.Errorf("session.Remux = %v, want %v", s.Remux, tt.wantRemux)
			}
			if s.HDRTonemap != tt.wantTonemap {
				t.Errorf("session.HDRTonemap = %v, want %v", s.HDRTonemap, tt.wantTonemap)
			}
			if s.SourceHDR != tt.opts.SourceHDR {
				t.Errorf("session.SourceHDR = %v, want %v (must be carried for cast clones)", s.SourceHDR, tt.opts.SourceHDR)
			}
		})
	}
}

// TestCloneForCast_HDRRemuxSource verifies the full chain for casting an HDR
// remux session: the clone always re-encodes video for the Default Media
// Receiver, so CreateSession's SourceHDR re-derivation must switch tonemapping
// on even though the source session (video copy) had HDRTonemap=false.
func TestCloneForCast_HDRRemuxSource(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	src, err := tm.CreateSession(1, "alice", "/tmp/hdr.mkv", 3840, 2160, SessionOpts{
		Remux:            true,
		RemuxAudioCopy:   true,
		AudioCodecOut:    "aac",
		SourceHDR:        true,
		SourceVideoCodec: "hevc",
	})
	if err != nil {
		t.Fatalf("CreateSession(src): %v", err)
	}
	if !src.Remux || src.HDRTonemap {
		t.Fatalf("src session Remux=%v HDRTonemap=%v, want remux without tonemap", src.Remux, src.HDRTonemap)
	}

	clone, err := tm.CloneForCast(1, "alice", src.ID, -1)
	if err != nil {
		t.Fatalf("CloneForCast: %v", err)
	}
	if clone.ID == src.ID {
		t.Fatal("CloneForCast returned the source session; a remux source must be cloned")
	}
	if clone.Remux {
		t.Error("cast clone of a remux source must transcode (Remux=false)")
	}
	if !clone.HDRTonemap {
		t.Error("cast clone re-encodes video from an HDR source but HDRTonemap=false — washed-out cast output")
	}
	if clone.FMP4 {
		t.Error("cast clone must use MPEG-TS segments (ForceTS)")
	}
}

// TestIsHDRColorTransfer pins the canonical HDR transfer-function set. Keep in
// sync with hdrColorTransfers (internal/db) and formatHdr() in lib/detail.ts.
func TestIsHDRColorTransfer(t *testing.T) {
	hdr := []string{"smpte2084", "arib-std-b67", "SMPTE2084", " smpte2084 "}
	for _, v := range hdr {
		if !IsHDRColorTransfer(v) {
			t.Errorf("IsHDRColorTransfer(%q) = false, want true", v)
		}
	}
	sdr := []string{"", "bt709", "bt2020-10", "smpte170m", "unknown"}
	for _, v := range sdr {
		if IsHDRColorTransfer(v) {
			t.Errorf("IsHDRColorTransfer(%q) = true, want false", v)
		}
	}
}

func TestCreateSession_GlobalLimitSentinel(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{
		MaxSessions:        1,
		MaxSessionsPerUser: 5,
	})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	if _, err := tm.CreateSession(1, "alice", "/tmp/a.mkv", 1920, 1080); err != nil {
		t.Fatalf("first session: %v", err)
	}
	if _, err := tm.CreateSession(2, "bob", "/tmp/b.mkv", 1920, 1080); !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("over-global-cap session: err = %v, want ErrSessionLimit", err)
	}
}

// newTestVariant builds a started, Ready-closed variant with a no-op Cancel,
// reporting whether Cancel was invoked.
func newTestVariant(name string, lastFetch time.Time) (*QualityVariant, *bool) {
	ready := make(chan struct{})
	close(ready)
	cancelled := false
	v := &QualityVariant{
		Profile:   QualityProfile{Name: name},
		Ready:     ready,
		started:   true,
		lastFetch: lastFetch,
	}
	v.Cancel = func() { cancelled = true }
	return v, &cancelled
}

func TestReapIdleVariants(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	stale := time.Now().Add(-2 * variantIdleTimeout)
	fresh := time.Now()

	staleV, staleCancelled := newTestVariant("720p", stale)
	freshV, freshCancelled := newTestVariant("1080p", fresh)
	subsV, subsCancelled := newTestVariant("480p", stale) // stale but carries subs

	notReady := &QualityVariant{ // stale but still priming — must be skipped
		Profile:   QualityProfile{Name: "360p"},
		Ready:     make(chan struct{}), // NOT closed
		started:   true,
		lastFetch: stale,
	}
	nrCancelled := false
	notReady.Cancel = func() { nrCancelled = true }

	s := &TranscodeSession{
		ID: "sess-reap",
		Variants: map[string]*QualityVariant{
			"720p": staleV, "1080p": freshV, "480p": subsV, "360p": notReady,
		},
		subsCarrierProfile: "480p",
		LastAccess:         time.Now(),
	}
	tm.mu.Lock()
	tm.sessions[s.ID] = s
	tm.mu.Unlock()

	tm.reapIdleVariants()

	if !staleV.reaped || !*staleCancelled {
		t.Error("stale idle variant was not reaped/cancelled")
	}
	if freshV.reaped || *freshCancelled {
		t.Error("recently-fetched variant must not be reaped")
	}
	if subsV.reaped || *subsCancelled {
		t.Error("subtitle-carrier variant must never be reaped")
	}
	if notReady.reaped || nrCancelled {
		t.Error("still-priming (Ready open) variant must not be reaped")
	}

	// Idempotent: a second sweep must not double-cancel the reaped variant.
	*staleCancelled = false
	tm.reapIdleVariants()
	if *staleCancelled {
		t.Error("already-reaped variant was cancelled again")
	}
}

// wantSeek asserts a resume seek lands at or after `boundary` and no more
// than `slackSec` past it. At-or-after is the load-bearing half: seeking even
// fractionally before a boundary makes -noaccurate_seek snap back to the
// previous key frame and duplicate a whole GOP.
func wantSeek(t *testing.T, got, boundary, slackSec float64, what string) {
	t.Helper()
	if got < boundary {
		t.Errorf("%s: seek %.6f is BEFORE the boundary %.6f — the resume duplicates a GOP",
			what, got, boundary)
		return
	}
	if got > boundary+slackSec {
		t.Errorf("%s: seek %.6f is %.6fs past the boundary %.6f — that much A/V is dropped",
			what, got, got-boundary, boundary)
	}
}

// writeCoverage lays down a variant playlist of `through`+1 segments, each
// `dur` seconds, plus the matching segment files.
func writeCoverage(t *testing.T, dir string, through int, dur float64) {
	t.Helper()
	var pl strings.Builder
	pl.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:9\n")
	pl.WriteString("#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MEDIA-SEQUENCE:0\n")
	for i := 0; i <= through; i++ {
		name := fmt.Sprintf("seg_%05d.ts", i)
		pl.WriteString(fmt.Sprintf("#EXTINF:%.6f,\n%s\n", dur, name))
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, 64*1024), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, variantPlaylistName), []byte(pl.String()), 0o644); err != nil {
		t.Fatalf("write playlist: %v", err)
	}
}

// The resume anchor must be the last PUBLISHED segment, not the newest file on
// disk. FFmpeg appends to the playlist only after a segment is fully written,
// so the playlist tail is the last complete one; the directory also holds the
// partial that SIGKILL interrupted. Anchoring on the partial resumes one
// segment too far and +append_list then appends past the playlist's real tail,
// skipping that segment's content and leaving this tier's cumulative EXTINF
// permanently short against its siblings.
//
// This regressed silently because the lookup named a file FFmpeg does not
// write, and a partial 720p/1080p segment clears minSegmentSizeBytes easily so
// the size heuristic did not catch it either.
func TestHighestSegmentNumber_PrefersPlaylistOverPartialOnDisk(t *testing.T) {
	// The literal is deliberate: writing the fixture through
	// variantPlaylistName would move both sides together, so a constant that
	// drifted away from the muxer's output name again would go unnoticed —
	// which is the exact regression this test is named for.
	if variantPlaylistName != "stream.m3u8" {
		t.Fatalf("variantPlaylistName = %q, but FFmpeg's HLS muxer is pointed at stream.m3u8; "+
			"a drift here silently disables the playlist-preferred resume anchor", variantPlaylistName)
	}
	varDir := t.TempDir()
	writeCoverage(t, varDir, 87, 6.0)

	// Mid-write when the kill landed: on disk, never published, well over
	// minSegmentSizeBytes.
	if err := os.WriteFile(filepath.Join(varDir, "seg_00088.ts"), make([]byte, 300*1024), 0o644); err != nil {
		t.Fatalf("write partial: %v", err)
	}

	if got := highestSegmentNumber(varDir); got != 87 {
		t.Errorf("highestSegmentNumber = %d, want 87 — anchored on the unpublished partial, "+
			"so the resume would skip seg_00088's content entirely", got)
	}
}

// resumePoint must seek by the durations the muxer wrote, not by
// segmentIndex*SegmentDuration. A remux cuts on source keyframes, so its
// segments are not SegmentDuration long and the index arithmetic seeks
// minutes away from the segment number it simultaneously tells FFmpeg to
// start writing at.
func TestResumePoint_UsesPublishedDurationsNotSegmentIndex(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentDuration: 6})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	// 8s real segments against a nominal 6s grid, 0..150 published.
	v := &QualityVariant{Profile: QualityProfile{Name: "source"}, OutputDir: t.TempDir()}
	writeCoverage(t, v.OutputDir, 150, 8.0)

	gotSec, gotSeg := tm.resumePoint(&TranscodeSession{Remux: true}, v, 0)

	if gotSeg != 151 {
		t.Errorf("resumeSegNum = %d, want 151", gotSeg)
	}
	// 151 * 8s = 1208s. The index math would give 151*6 = 906s.
	wantSeek(t, gotSec, 1208, 0.002, "remux resume by published duration")
}

// A remux boundary IS a source keyframe, so the seek must land at-or-after it.
// Rounding down makes FFmpeg's input seek snap back to the previous keyframe
// and duplicate a whole GOP into the resumed output.
func TestResumePoint_RoundsSeekUpOntoTheKeyframeBoundary(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentDuration: 6})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	v := &QualityVariant{Profile: QualityProfile{Name: "source"}, OutputDir: t.TempDir()}
	writeCoverage(t, v.OutputDir, 9, 4.17)

	gotSec, _ := tm.resumePoint(&TranscodeSession{Remux: true}, v, 0)
	// 10 * 4.17 = 41.7. On the remux path the seek must land at or just
	// after it — a whole-second ceil would push it to 42 and drop 0.3s.
	wantSeek(t, gotSec, 41.7, 0.002, "seek lands on the keyframe boundary")
}

// 23.976fps on a 6s key-frame grid emits #EXTINF:6.006000 exactly, and 1000
// of those sum to 6006.000000000062 in float64 against an exact 6006. A bare
// Ceil turns that into 6007 and the resume skips a full second of A/V —
// roughly 100 minutes into a feature, i.e. an ordinary late-movie reap.
func TestResumePoint_FloatAccumulationDoesNotOvershootAWholeSecond(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentDuration: 6})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	v := &QualityVariant{Profile: QualityProfile{Name: "1080p"}, OutputDir: t.TempDir()}
	writeCoverage(t, v.OutputDir, 999, 6.006) // 1000 segments

	gotSec, gotSeg := tm.resumePoint(&TranscodeSession{Remux: true}, v, 0)
	if gotSeg != 1000 {
		t.Errorf("resumeSegNum = %d, want 1000", gotSeg)
	}
	wantSeek(t, gotSec, 6006, 0.002, "1000 x 6.006 segments")
}

// The case a uniform-EXTINF fixture cannot express. -force_key_frames puts
// the key frame on the first frame at or AFTER each grid mark, so on 23.976fps
// content the real boundaries sit a few ms past each 6s multiple and the
// per-segment EXTINFs are not identical. Quantising the seek to a whole second
// there drops almost the entire second — and only remux gets
// -noaccurate_seek, so a transcode seeks to exactly what it is told and keeps
// nothing back.
func TestResumePoint_NTSCBoundariesDoNotLoseNearlyASecond(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentDuration: 6})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	// 23.976fps: frames land on multiples of 1001/24000s. The key frame at or
	// after each 6s mark puts boundary N at ceil(6N * 24000/1001) frames.
	const frameNum, frameDen = 1001.0, 24000.0
	boundary := func(n int) float64 {
		frames := math.Ceil(float64(n) * 6 * frameDen / frameNum)
		return frames * frameNum / frameDen
	}

	dir := t.TempDir()
	var pl strings.Builder
	pl.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n")
	const nSeg = 99
	for i := 0; i < nSeg; i++ {
		name := fmt.Sprintf("seg_%05d.ts", i)
		// Exactly how FFmpeg prints it: six decimals.
		pl.WriteString(fmt.Sprintf("#EXTINF:%.6f,\n%s\n", boundary(i+1)-boundary(i), name))
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, 8192), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, variantPlaylistName), []byte(pl.String()), 0o644); err != nil {
		t.Fatalf("write playlist: %v", err)
	}

	trueBoundary := boundary(nSeg) // ~594.010083, NOT 594.0
	if trueBoundary == math.Trunc(trueBoundary) {
		t.Fatalf("fixture is not exercising a fractional boundary: %v", trueBoundary)
	}

	v := &QualityVariant{Profile: QualityProfile{Name: "1080p"}, OutputDir: dir}
	gotSec, gotSeg := tm.resumePoint(&TranscodeSession{Remux: true}, v, 0)

	if gotSeg != nSeg {
		t.Errorf("resumeSegNum = %d, want %d", gotSeg, nSeg)
	}
	// 2ms of slack. A whole-second Ceil would land on 595 — ~0.99s of A/V
	// silently missing from this tier, on every reap-resume.
	wantSeek(t, gotSec, trueBoundary, 0.002, "23.976fps resume")
}

// FFmpeg prints #EXTINF to six decimals, so the published sum can sit a
// fraction BELOW the true boundary. Seeking to that sum lands before the key
// frame, and -noaccurate_seek then snaps back to the previous one and
// duplicates a whole GOP into the resumed output. resumeSeekBias is what
// keeps the target on the far side of that rounding.
func TestResumePoint_EpsilonCoversEXTINFPrintRounding(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentDuration: 6})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	// The true duration must carry MORE precision than the printed form, or
	// there is no under-reporting to detect: 720058/90000 = 8.0006444444...
	// prints as "8.000644", losing 4.444e-7s per entry. That is the worst
	// constant-GOP case in the 1/90000 mpegts timebase FFmpeg computes
	// segment durations in.
	//
	// nSeg is feature length on purpose. A fixed bias covers only
	// 1e-4/5e-7 = 200 entries, so a short fixture proves nothing about the
	// movies this actually runs on; at 1200 entries the shortfall is
	// ~5.3e-4s, past a fixed budget and the millisecond ceil combined.
	const trueDur = 720058.0 / 90000.0
	const nSeg = 1200

	dir := t.TempDir()
	var pl strings.Builder
	pl.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n")
	for i := 0; i < nSeg; i++ {
		name := fmt.Sprintf("seg_%05d.ts", i)
		pl.WriteString(fmt.Sprintf("#EXTINF:%.6f,\n%s\n", trueDur, name))
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, 8192), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, variantPlaylistName), []byte(pl.String()), 0o644); err != nil {
		t.Fatalf("write playlist: %v", err)
	}

	// 1200 * 8.0006444... = 9600.773333; the playlist's printed sum is
	// 9600.772800, short by ~5.3e-4s.
	trueBoundary := trueDur * nSeg

	v := &QualityVariant{Profile: QualityProfile{Name: "1080p"}, OutputDir: dir}
	gotSec, _ := tm.resumePoint(&TranscodeSession{Remux: true}, v, 0)

	wantSeek(t, gotSec, trueBoundary, 0.002, "printed sum under-reports the boundary")
}

// A corrupt playlist can sum to something absurd. int() on a non-finite or
// out-of-range float is not defined to anything useful and yields a negative
// -ss, which stops FFmpeg launching at all — so the variant would never
// resume. Fall back to the index arithmetic instead.
func TestResumePoint_ImplausibleSumFallsBackToIndexArithmetic(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentDuration: 6})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	dir := t.TempDir()
	// Finite and non-negative, so the per-entry guards pass; the SUM is what
	// is implausible.
	body := "#EXTM3U\n#EXTINF:1e300,\nseg_00000.ts\n#EXTINF:1e300,\nseg_00001.ts\n"
	if err := os.WriteFile(filepath.Join(dir, variantPlaylistName), []byte(body), 0o644); err != nil {
		t.Fatalf("write playlist: %v", err)
	}
	for i := 0; i <= 1; i++ {
		name := fmt.Sprintf("seg_%05d.ts", i)
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, 64*1024), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	v := &QualityVariant{Profile: QualityProfile{Name: "source"}, OutputDir: dir}
	gotSec, gotSeg := tm.resumePoint(&TranscodeSession{Remux: true}, v, 0)

	if gotSec < 0 {
		t.Errorf("resumeFromSec = %v — a negative -ss stops FFmpeg launching and the "+
			"variant never resumes", gotSec)
	}
	// Index fallback: 2 published segments * 6s.
	if gotSeg != 2 || gotSec != 12 {
		t.Errorf("resumePoint = (%v, %d), want (12, 2) from the index fallback", gotSec, gotSeg)
	}
}

// The two delivery paths get opposite FFmpeg seek modes and therefore want
// opposite sides of the boundary. Remux gets -noaccurate_seek, where no trim
// filter is inserted and the demuxer's landing point IS the output start, so
// it must aim past. Transcode seeks accurately and a trim filter discards
// every frame before the target, so aiming past throws the boundary frame
// away — the one choice that cannot land on it.
func TestResumePoint_BiasesForwardOnlyForRemux(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentDuration: 6})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	// A boundary that is NOT on a millisecond, so the two roundings differ.
	const nSeg = 99
	const dur = 6.0001005
	boundary := dur * nSeg // 594.0099495

	build := func(t *testing.T) *QualityVariant {
		t.Helper()
		dir := t.TempDir()
		var pl strings.Builder
		pl.WriteString("#EXTM3U\n#EXT-X-TARGETDURATION:7\n")
		for i := 0; i < nSeg; i++ {
			name := fmt.Sprintf("seg_%05d.ts", i)
			pl.WriteString(fmt.Sprintf("#EXTINF:%.6f,\n%s\n", dur, name))
			if err := os.WriteFile(filepath.Join(dir, name), make([]byte, 8192), 0o644); err != nil {
				t.Fatalf("write %s: %v", name, err)
			}
		}
		if err := os.WriteFile(filepath.Join(dir, variantPlaylistName), []byte(pl.String()), 0o644); err != nil {
			t.Fatalf("write playlist: %v", err)
		}
		return &QualityVariant{Profile: QualityProfile{Name: "720p"}, OutputDir: dir}
	}

	remuxSec, _ := tm.resumePoint(&TranscodeSession{Remux: true}, build(t), 0)
	if remuxSec < boundary {
		t.Errorf("remux seek %.6f is before the boundary %.6f — -noaccurate_seek snaps back "+
			"to the previous key frame and duplicates a GOP", remuxSec, boundary)
	}

	transSec, _ := tm.resumePoint(&TranscodeSession{Remux: false}, build(t), 0)
	if transSec > boundary {
		t.Errorf("transcode seek %.6f is past the boundary %.6f — accurate seek discards every "+
			"frame before the target, so the boundary frame is dropped and the next segment "+
			"comes out ~2x long", transSec, boundary)
	}
	// Still close enough that the first frame at or after the target IS the
	// boundary frame. 2ms, not a frame interval: the tolerance has to be
	// tight enough that a whole-second floor (which this fixture undershoots
	// by ~9.9ms) fails, or the millisecond half of the change is unpinned.
	if boundary-transSec > 0.002 {
		t.Errorf("transcode seek %.6f undershoots the boundary %.6f by %.6fs — more than a "+
			"frame interval and content is duplicated", transSec, boundary, boundary-transSec)
	}
}

// An unknown session must take the conservative side. Overshooting costs a
// frame; undershooting a remux costs a whole GOP, so "don't know" has to mean
// "assume remux".
func TestResumePoint_NilSessionTakesTheRemuxSide(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentDuration: 6})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	const nSeg, dur = 99, 6.0001005
	boundary := dur * nSeg

	dir := t.TempDir()
	var pl strings.Builder
	pl.WriteString("#EXTM3U\n#EXT-X-TARGETDURATION:7\n")
	for i := 0; i < nSeg; i++ {
		name := fmt.Sprintf("seg_%05d.ts", i)
		pl.WriteString(fmt.Sprintf("#EXTINF:%.6f,\n%s\n", dur, name))
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, 8192), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, variantPlaylistName), []byte(pl.String()), 0o644); err != nil {
		t.Fatalf("write playlist: %v", err)
	}

	v := &QualityVariant{Profile: QualityProfile{Name: "720p"}, OutputDir: dir}
	gotSec, _ := tm.resumePoint(nil, v, 0)

	if gotSec < boundary {
		t.Errorf("nil-session seek %.6f is before the boundary %.6f — an unknown session fell "+
			"on the transcode side, which costs a remux a whole GOP", gotSec, boundary)
	}
}

// pubSec > 0 does not cover the transcode branch: a sum under a millisecond
// floors to nothing, and resuming from the seek origin numbered past the
// existing tail would re-encode the file over live segments.
func TestResumePoint_SubMillisecondSumFallsBackToIndexArithmetic(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentDuration: 6})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	dir := t.TempDir()
	body := "#EXTM3U\n#EXTINF:0.000500,\nseg_00000.ts\n"
	if err := os.WriteFile(filepath.Join(dir, variantPlaylistName), []byte(body), 0o644); err != nil {
		t.Fatalf("write playlist: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "seg_00000.ts"), make([]byte, 64*1024), 0o644); err != nil {
		t.Fatalf("write segment: %v", err)
	}

	v := &QualityVariant{Profile: QualityProfile{Name: "720p"}, OutputDir: dir}
	gotSec, gotSeg := tm.resumePoint(&TranscodeSession{Remux: false}, v, 0)

	// Index fallback: 1 published segment * 6s.
	if gotSeg != 1 || gotSec != 6 {
		t.Errorf("resumePoint = (%v, %d), want (6, 1) from the index fallback — a sub-millisecond "+
			"sum resumed from the seek origin over live segments", gotSec, gotSeg)
	}
}

func TestResumeSeekBias(t *testing.T) {
	// Scales with entry count: a feature-length playlist needs far more than
	// the floor, which covers only 1e-4/5e-7 = 200 entries.
	if got, want := resumeSeekBias(1200), 6e-4; got < want*0.999 || got > want*1.001 {
		t.Errorf("resumeSeekBias(1200) = %v, want ~%v — a fixed bias leaves a feature-length "+
			"remux seeking before its boundary", got, want)
	}
	// Floored for short playlists, where the scaled term alone would be tiny.
	if got := resumeSeekBias(10); got != resumeSeekMinBias {
		t.Errorf("resumeSeekBias(10) = %v, want the %v floor", got, resumeSeekMinBias)
	}
	// Monotonic — a longer playlist never gets less margin.
	if resumeSeekBias(500) > resumeSeekBias(1000) {
		t.Error("bias must not decrease as the playlist grows")
	}
}

func TestFormatSeekSeconds(t *testing.T) {
	tests := []struct {
		in   float64
		want string
	}{
		// A fresh start's command line must be unchanged by the resume work.
		{0, "0"},
		{1200, "1200"},
		// A resume keeps its millisecond — this is the difference between
		// landing on the boundary and losing back to the previous second.
		{594.011, "594.011"},
		{6006.001, "6006.001"},
		{41.7, "41.700"},
		// Domain guard: +Inf satisfies sec == Trunc(sec), so without it the
		// integer branch renders int64(+Inf) as -9223372036854775808 — a
		// negative -ss that stops FFmpeg launching at all.
		{math.Inf(1), "0"},
		{math.NaN(), "0"},
		{-5, "0"},
		{maxResumeSeekSec + 1, "0"},
	}
	for _, tt := range tests {
		if got := formatSeekSeconds(tt.in); got != tt.want {
			t.Errorf("formatSeekSeconds(%v) = %q, want %q — a truncated -ss discards "+
				"everything back to the previous whole second", tt.in, got, tt.want)
		}
	}
}

// The seek is relative to the session's own start, so a session built by a
// seek must not have its published duration double-counted.
func TestResumePoint_AddsPublishedDurationToStartSec(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentDuration: 6})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	v := &QualityVariant{Profile: QualityProfile{Name: "720p"}, OutputDir: t.TempDir()}
	writeCoverage(t, v.OutputDir, 9, 6.0) // 60s published

	gotSec, gotSeg := tm.resumePoint(&TranscodeSession{Remux: true}, v, 1200)
	if gotSeg != 10 {
		t.Errorf("resumeSegNum = %d, want 10", gotSeg)
	}
	wantSeek(t, gotSec, 1260, 0.002, "startSec 1200 + 60s published")
}

func TestPlaylistCoverage(t *testing.T) {
	write := func(t *testing.T, body string) string {
		t.Helper()
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, variantPlaylistName), []byte(body), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		return filepath.Join(dir, variantPlaylistName)
	}

	tests := []struct {
		name    string
		body    string
		wantSeg int
		wantSec float64
	}{
		{
			name:    "missing file",
			body:    "",
			wantSeg: -1,
		},
		{
			name:    "empty file",
			body:    "\x00", // sentinel: written as a zero-byte file below
			wantSeg: -1,
		},
		{
			name:    "header only",
			body:    "#EXTM3U\n#EXT-X-TARGETDURATION:6\n",
			wantSeg: -1,
		},
		{
			name:    "plain",
			body:    "#EXTM3U\n#EXTINF:6.000000,\nseg_00000.ts\n#EXTINF:6.000000,\nseg_00001.ts\n",
			wantSeg: 1,
			wantSec: 12,
		},
		{
			name:    "CRLF and ENDLIST",
			body:    "#EXTM3U\r\n#EXTINF:6.0,\r\nseg_00000.ts\r\n#EXT-X-ENDLIST\r\n",
			wantSeg: 0,
			wantSec: 6,
		},
		{
			name: "fMP4 MAP and init are not segments",
			body: "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.0,\nseg_00000.m4s\n",
			// init.mp4 must not count toward the highest segment number.
			wantSeg: 0,
			wantSec: 6,
		},
		{
			name:    "discontinuity does not disturb the sum",
			body:    "#EXTM3U\n#EXTINF:6.0,\nseg_00000.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:6.0,\nseg_00001.ts\n",
			wantSeg: 1,
			wantSec: 12,
		},
		{
			name:    "titled EXTINF",
			body:    "#EXTM3U\n#EXTINF:6.5,some title\nseg_00003.ts\n",
			wantSeg: 3,
			wantSec: 6.5,
		},
		{
			name:    "trailing EXTINF with no URI contributes nothing",
			body:    "#EXTM3U\n#EXTINF:6.0,\nseg_00000.ts\n#EXTINF:6.0,\n",
			wantSeg: 0,
			wantSec: 6,
		},
		{
			name:    "segments with no parsable EXTINF sum to zero",
			body:    "#EXTM3U\nseg_00000.ts\nseg_00001.ts\n",
			wantSeg: 1,
			wantSec: 0,
		},
		{
			// What havePending actually guards: a second URI under one
			// EXTINF must not bill the duration twice, which would push the
			// resume anchor past the real boundary.
			name:    "two URIs after one EXTINF count the duration once",
			body:    "#EXTM3U\n#EXTINF:6.0,\nseg_00000.ts\nseg_00001.ts\n",
			wantSeg: 1,
			wantSec: 6,
		},
		{
			name:    "negative duration is ignored",
			body:    "#EXTM3U\n#EXTINF:-1,\nseg_00000.ts\n#EXTINF:6.0,\nseg_00001.ts\n",
			wantSeg: 1,
			wantSec: 6,
		},
		{
			// Inf parses and passes d >= 0; int(+Inf) is not defined to
			// anything useful and would produce a negative -ss.
			name:    "infinite duration is ignored",
			body:    "#EXTM3U\n#EXTINF:Inf,\nseg_00000.ts\n#EXTINF:6.0,\nseg_00001.ts\n",
			wantSeg: 1,
			wantSec: 6,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "absent.m3u8")
			switch tt.body {
			case "":
				// leave the path nonexistent
			case "\x00":
				path = write(t, "") // a real, zero-byte playlist
			default:
				path = write(t, tt.body)
			}
			gotSeg, gotSec := playlistCoverage(path)
			if gotSeg != tt.wantSeg {
				t.Errorf("highestSeg = %d, want %d", gotSeg, tt.wantSeg)
			}
			if diff := gotSec - tt.wantSec; diff > 0.001 || diff < -0.001 {
				t.Errorf("publishedSec = %v, want %v", gotSec, tt.wantSec)
			}
		})
	}
}

// A playlist that lists segments but carries no usable EXTINF must NOT be
// treated as "resume from the seek origin" — that would re-encode the whole
// file numbered past the existing tail, overwriting live segments.
func TestResumePoint_IgnoresPlaylistWithNoParsableDurations(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentDuration: 6})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	dir := t.TempDir()
	body := "#EXTM3U\nseg_00000.ts\nseg_00001.ts\nseg_00002.ts\n"
	if err := os.WriteFile(filepath.Join(dir, variantPlaylistName), []byte(body), 0o644); err != nil {
		t.Fatalf("write playlist: %v", err)
	}
	for i := 0; i <= 2; i++ {
		name := fmt.Sprintf("seg_%05d.ts", i)
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, 64*1024), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	v := &QualityVariant{Profile: QualityProfile{Name: "source"}, OutputDir: dir}
	gotSec, gotSeg := tm.resumePoint(&TranscodeSession{Remux: true}, v, 0)

	if gotSeg != 3 {
		t.Errorf("resumeSegNum = %d, want 3", gotSeg)
	}
	// Falls back to the index arithmetic rather than returning startSec.
	if gotSec != 18 {
		t.Errorf("resumeFromSec = %v, want 18 (fallback), not the seek origin", gotSec)
	}
}

func TestEnsureVariant_ReapedResumesWithoutBurningRestartBudget(t *testing.T) {
	fakeFFmpegOnPath(t) // resume path execs ffmpeg (stub: start succeeds, exits 1)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	ready := make(chan struct{})
	close(ready)
	v := &QualityVariant{
		Profile:   QualityProfile{Name: "source"},
		OutputDir: t.TempDir(),
		Ready:     ready,
		started:   true,
		exited:    true, // cancel completed
		reaped:    true, // stopped by the reaper, NOT crashed (Err == nil)
	}
	s := &TranscodeSession{
		ID:         "sess-resume",
		FilePath:   "/tmp/x.mkv",
		Variants:   map[string]*QualityVariant{"source": v},
		LastAccess: time.Now(),
		Remux:      true,
	}

	got, err := tm.EnsureVariant(s, "source", 0)
	if err != nil {
		t.Fatalf("EnsureVariant on reaped variant: %v", err)
	}
	if got != v {
		t.Fatal("EnsureVariant returned a different variant")
	}
	if v.reaped {
		t.Error("reaped flag not cleared on resume")
	}
	if !v.started {
		t.Error("variant not restarted")
	}
	if v.restartAttempts != 0 {
		t.Errorf("restartAttempts = %d, want 0 — reap-resume must not consume the crash budget", v.restartAttempts)
	}
}

func TestServeVariantPlaylist_FMP4TokenRewrite(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()
	if !tm.FMP4Enabled() {
		t.Fatal("fmp4 mode not enabled")
	}

	varDir := filepath.Join(tm.baseDir, "sess-fmp4", "source")
	if err := os.MkdirAll(varDir, 0o750); err != nil {
		t.Fatal(err)
	}
	playlist := "#EXTM3U\r\n" +
		"#EXT-X-MAP:URI=\"init.mp4\"\r\n" +
		"#EXTINF:6.0,\r\n" +
		"seg_00000.m4s\r\n"
	if err := os.WriteFile(filepath.Join(varDir, "stream.m3u8"), []byte(playlist), 0o640); err != nil {
		t.Fatal(err)
	}

	ready := make(chan struct{})
	close(ready)
	v := &QualityVariant{
		Profile:   QualityProfile{Name: "source"},
		OutputDir: varDir,
		Ready:     ready,
		started:   true,
		exited:    true, // clean completion → served as-is
	}
	s := &TranscodeSession{
		ID:         "sess-fmp4",
		OutputDir:  filepath.Join(tm.baseDir, "sess-fmp4"),
		Variants:   map[string]*QualityVariant{"source": v},
		Profiles:   []QualityProfile{{Name: "source"}},
		LastAccess: time.Now(),
		Remux:      true,
	}
	tm.mu.Lock()
	tm.sessions[s.ID] = s
	tm.mu.Unlock()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/stream/hls/sess-fmp4/source/stream.m3u8", nil)
	tm.ServeVariantPlaylist(rec, req, "sess-fmp4", "source", "CASTTOKEN")

	body := rec.Body.String()
	if !strings.Contains(body, `URI="init.mp4?token=CASTTOKEN"`) {
		t.Errorf("EXT-X-MAP URI not token-rewritten:\n%s", body)
	}
	if !strings.Contains(body, "seg_00000.m4s?token=CASTTOKEN") {
		t.Errorf(".m4s segment line not token-rewritten:\n%s", body)
	}
	if strings.Contains(body, "\r") {
		t.Error("playlist line endings not normalized to LF")
	}
	wantHeader := "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n"
	if !strings.HasPrefix(body, wantHeader) {
		t.Errorf("EXT-X-START not injected immediately after #EXTM3U:\n%s", body)
	}
}

// TestServeVariantPlaylist_StartTagPlainCookieAuth covers the plain-cookie
// path (no ?token=, e.g. hls.js over cookie auth) — #435 extended the
// EXT-X-START injection here too, replacing the old http.ServeFile
// fall-through so every variant playlist gets the tag, not just the
// cast-token/native-HLS one.
func TestServeVariantPlaylist_StartTagPlainCookieAuth(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "ts"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	varDir := filepath.Join(tm.baseDir, "sess-plain", "source")
	if err := os.MkdirAll(varDir, 0o750); err != nil {
		t.Fatal(err)
	}
	playlist := "#EXTM3U\n" +
		"#EXT-X-VERSION:3\n" +
		"#EXTINF:6.0,\n" +
		"seg_00000.ts\n"
	if err := os.WriteFile(filepath.Join(varDir, "stream.m3u8"), []byte(playlist), 0o640); err != nil {
		t.Fatal(err)
	}

	ready := make(chan struct{})
	close(ready)
	v := &QualityVariant{
		Profile:   QualityProfile{Name: "source"},
		OutputDir: varDir,
		Ready:     ready,
		started:   true,
		exited:    true,
	}
	s := &TranscodeSession{
		ID:         "sess-plain",
		OutputDir:  filepath.Join(tm.baseDir, "sess-plain"),
		Variants:   map[string]*QualityVariant{"source": v},
		Profiles:   []QualityProfile{{Name: "source"}},
		LastAccess: time.Now(),
		Remux:      true,
	}
	tm.mu.Lock()
	tm.sessions[s.ID] = s
	tm.mu.Unlock()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/stream/hls/sess-plain/source/stream.m3u8", nil)
	tm.ServeVariantPlaylist(rec, req, "sess-plain", "source", "")

	body := rec.Body.String()
	wantHeader := "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n"
	if !strings.HasPrefix(body, wantHeader) {
		t.Errorf("EXT-X-START not injected on plain-cookie path:\n%s", body)
	}
	if strings.Contains(body, "?token=") {
		t.Error("no token was supplied, playlist should not gain a ?token= suffix")
	}
	if !strings.Contains(body, "seg_00000.ts\n") {
		t.Errorf("segment line unexpectedly altered:\n%s", body)
	}
}

// TestServeVariantPlaylist_StartTagInjection covers the actual #435 bug
// shape (an in-progress EVENT playlist with no #EXT-X-ENDLIST yet, FFmpeg
// still running — the earlier tests only exercise a clean-completion,
// already-static playlist) plus the malformed-file safety net: a playlist
// that doesn't start with #EXTM3U must be served byte-for-byte unchanged
// rather than gaining a prepended tag ahead of an invalid first line.
func TestServeVariantPlaylist_StartTagInjection(t *testing.T) {
	tests := []struct {
		name         string
		playlist     string
		wantInjected bool
	}{
		{
			name: "in-progress event playlist, no ENDLIST",
			playlist: "#EXTM3U\n" +
				"#EXT-X-VERSION:3\n" +
				"#EXT-X-TARGETDURATION:6\n" +
				"#EXT-X-PLAYLIST-TYPE:EVENT\n" +
				"#EXT-X-MEDIA-SEQUENCE:0\n" +
				"#EXTINF:6.0,\n" +
				"seg_00000.ts\n",
			wantInjected: true,
		},
		{
			name:         "malformed playlist missing #EXTM3U",
			playlist:     "#EXTINF:6.0,\nseg_00000.ts\n",
			wantInjected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "ts"})
			if err != nil {
				t.Fatalf("new transcode manager: %v", err)
			}
			defer tm.Close()

			varDir := filepath.Join(tm.baseDir, "sess-inprogress", "source")
			if err := os.MkdirAll(varDir, 0o750); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(varDir, "stream.m3u8"), []byte(tt.playlist), 0o640); err != nil {
				t.Fatal(err)
			}

			ready := make(chan struct{})
			close(ready)
			v := &QualityVariant{
				Profile:   QualityProfile{Name: "source"},
				OutputDir: varDir,
				Ready:     ready,
				started:   true,
				// exited stays false: FFmpeg is still running, mirroring the
				// no-ENDLIST-yet state that produces the #435 overshoot.
			}
			s := &TranscodeSession{
				ID:         "sess-inprogress",
				OutputDir:  filepath.Join(tm.baseDir, "sess-inprogress"),
				Variants:   map[string]*QualityVariant{"source": v},
				Profiles:   []QualityProfile{{Name: "source"}},
				LastAccess: time.Now(),
				Remux:      true,
			}
			tm.mu.Lock()
			tm.sessions[s.ID] = s
			tm.mu.Unlock()

			rec := httptest.NewRecorder()
			req := httptest.NewRequest("GET", "/api/stream/hls/sess-inprogress/source/stream.m3u8", nil)
			tm.ServeVariantPlaylist(rec, req, "sess-inprogress", "source", "")

			body := rec.Body.String()
			hasTag := strings.Contains(body, "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES")
			if hasTag != tt.wantInjected {
				t.Errorf("tag injected = %v, want %v:\n%s", hasTag, tt.wantInjected, body)
			}
			if !tt.wantInjected && body != tt.playlist {
				t.Errorf("malformed playlist body altered:\ngot:  %q\nwant: %q", body, tt.playlist)
			}
			if tt.wantInjected && !strings.HasPrefix(body, "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n") {
				t.Errorf("tag not placed immediately after #EXTM3U:\n%s", body)
			}
		})
	}
}

func TestDecideStatic_ReviewB3(t *testing.T) {
	// VP9 in MKV with no client caps: the old static path remuxed this into
	// MPEG-TS, which FFmpeg muxes as a private data stream nothing can play.
	pd := DecidePlayback("matroska", "vp9", nil, nil)
	if pd.Decision != "transcode" {
		t.Errorf("static mkv/vp9 decision = %q, want transcode", pd.Decision)
	}
	// MP3 audio on the static remux path must be re-encoded (mp3-in-TS
	// framing edge cases + master playlist advertises AAC).
	pd = DecidePlayback("matroska", "h264", aacLikeTracks("mp3"), nil)
	if pd.Decision != "direct_stream" || !pd.Remux {
		t.Fatalf("static mkv/h264/mp3 = %q (remux=%v), want direct_stream remux", pd.Decision, pd.Remux)
	}
	if pd.AudioPassthrough || !pd.AudioNeedsRecode {
		t.Error("static remux must re-encode mp3 audio, not copy it")
	}
	// AAC stays copyable.
	pd = DecidePlayback("matroska", "h264", aacLikeTracks("aac"), nil)
	if !pd.AudioPassthrough || pd.AudioNeedsRecode {
		t.Error("static remux should still copy AAC audio")
	}
}

func TestSegmentFormatParsing(t *testing.T) {
	for cfgVal, wantFMP4 := range map[string]bool{
		"": true, "fmp4": true, "cmaf": true, "FMP4": true,
		"ts": false, "mpegts": false, "TS": false,
		"bogus": true, // unknown → fmp4 with a warning
	} {
		tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: cfgVal})
		if err != nil {
			t.Fatalf("segment_format %q: %v", cfgVal, err)
		}
		if tm.FMP4Enabled() != wantFMP4 {
			t.Errorf("segment_format %q → fmp4=%v, want %v", cfgVal, tm.FMP4Enabled(), wantFMP4)
		}
		tm.Close()
	}
}
