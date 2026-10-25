package streaming

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

// The remux playback clock (media_start.go): a remux's media time 0 is the key
// frame before start_sec, and the variant playlist must say where that is.

const (
	barcodeFPS  = 24
	barcodeBits = 12
	barcodeBitW = 26
)

// barcodeFixture writes an H.264 file whose every frame carries its own frame
// number as a 12-bit bar code in the top rows (bit b = the block at x in
// [26b, 26b+26), white = 1), with a key frame exactly every gopSec seconds and
// no scene-cut key frames. Decoding any frame of any output therefore says
// which SOURCE second it shows, independently of every timestamp involved.
func barcodeFixture(t *testing.T, container, audioCodec string, gopSec, durationSec int) string {
	t.Helper()
	requireFFmpeg(t)
	requireFFmpegEncoders(t, "libx264", audioCodec)
	out := filepath.Join(t.TempDir(), fmt.Sprintf("barcode_gop%d.%s", gopSec, container))
	vf := fmt.Sprintf("color=c=gray:size=320x240:rate=%d:duration=%d,format=yuv420p,"+
		`geq=lum='if(lt(Y\,160)\,if(lt(X\,%d)\,255*mod(floor(N/pow(2\,floor(X/%d)))\,2)\,128)\,128)':cb=128:cr=128`,
		barcodeFPS, durationSec, barcodeBits*barcodeBitW, barcodeBitW)
	gop := strconv.Itoa(gopSec * barcodeFPS)
	args := []string{"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", vf,
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=440:duration=%d", durationSec),
		"-map", "0:v", "-map", "1:a",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
		"-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
		"-c:a", audioCodec, "-ac", "2", out}
	if b, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("generate bar-code fixture: %v\n%s", err, b)
	}
	return out
}

// firstFrameSourceSec decodes the first frame of a variant's first segment and
// returns the source second its bar code names.
func firstFrameSourceSec(t *testing.T, variantDir string) float64 {
	t.Helper()
	probe := filepath.Join(variantDir, "seg_00000.ts")
	if init, err := os.ReadFile(filepath.Join(variantDir, "init.mp4")); err == nil {
		frag, ferr := os.ReadFile(filepath.Join(variantDir, "seg_00000.m4s"))
		if ferr != nil {
			t.Fatalf("read first fragment: %v", ferr)
		}
		probe = filepath.Join(t.TempDir(), "first.mp4")
		if werr := os.WriteFile(probe, append(init, frag...), 0o644); werr != nil {
			t.Fatalf("join init+fragment: %v", werr)
		}
	}
	raw, err := exec.Command("ffmpeg", "-v", "error", "-i", probe, "-frames:v", "1",
		"-vf", "scale=320:240,format=gray", "-f", "rawvideo", "-").Output()
	if err != nil {
		t.Fatalf("decode first frame: %v", err)
	}
	if len(raw) < 81*320 {
		t.Fatalf("decoded frame too short: %d bytes", len(raw))
	}
	row := raw[80*320 : 81*320]
	n := 0
	for b := 0; b < barcodeBits; b++ {
		if row[b*barcodeBitW+barcodeBitW/2] > 128 {
			n |= 1 << b
		}
	}
	return float64(n) / barcodeFPS
}

// servePlaylist fetches a session's variant playlist through the real serving
// path.
func servePlaylist(t *testing.T, tm *TranscodeManager, s *TranscodeSession, v *QualityVariant) string {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/stream/hls/"+s.ID+"/"+v.Profile.Name+"/stream.m3u8", nil)
	tm.ServeVariantPlaylist(rec, req, s.ID, v.Profile.Name, "")
	if rec.Code != 200 {
		t.Fatalf("variant playlist: HTTP %d: %s", rec.Code, rec.Body.String())
	}
	return rec.Body.String()
}

// publishedMediaStart returns the playlist's media-start value, asserting the
// line has the shape every client relies on, or ok=false when absent.
func publishedMediaStart(t *testing.T, playlist string) (float64, bool) {
	t.Helper()
	lines := strings.Split(playlist, "\n")
	for i, line := range lines {
		raw, found := strings.CutPrefix(line, mediaStartTagPrefix)
		if !found {
			continue
		}
		// A comment, not a tag (RFC 8216 §4.1): third-party players must be
		// able to ignore it.
		if strings.HasPrefix(line, "#EXT") {
			t.Fatalf("media start line %q is a tag, not a comment", line)
		}
		// Directly before the FIRST segment's #EXTINF, which is where hls.js
		// files it on fragments[0]. Ahead of #EXT-X-MAP it would land on the
		// init segment instead (the Chromium run that found this).
		for _, before := range lines[:i] {
			if strings.HasPrefix(before, "#EXTINF") || (before != "" && !strings.HasPrefix(before, "#")) {
				t.Fatalf("media start line follows a segment:\n%s", playlist)
			}
		}
		if i+1 >= len(lines) || !strings.HasPrefix(lines[i+1], "#EXTINF") {
			t.Fatalf("media start line is not immediately before the first #EXTINF:\n%s", playlist)
		}
		sec, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			t.Fatalf("unparsable media start %q", raw)
		}
		return sec, true
	}
	return 0, false
}

// TestRemuxMediaStart_PublishesWhereTheProducedMediaBegins runs the server's
// own remux argv over a 10 s-GOP source and checks the published origin
// against the picture: the bar code of the first frame FFmpeg wrote.
//
// Starting at 15 s, the copy cannot begin before the key frame at 10 s, so the
// gap the player used to read as "15 s" is 5 s. Starting at 20 s — on a key
// frame — is the Matroska case: FFmpeg's dts heuristic seeks 130 ms early and
// lands a whole GOP back, which a key-frame index would not predict. Either
// way the assertion is the same: the published start is where the first
// frame really is.
func TestRemuxMediaStart_PublishesWhereTheProducedMediaBegins(t *testing.T) {
	requireFFmpeg(t)
	for _, container := range []string{"mkv", "mp4"} {
		src := barcodeFixture(t, container, "aac", 10, 40)
		for _, format := range []string{"fmp4", "ts"} {
			for _, startSec := range []int{15, 20} {
				t.Run(fmt.Sprintf("%s/%s/start_%d", container, format, startSec), func(t *testing.T) {
					cfg := matrixConfig()
					cfg.SegmentFormat = format
					cfg.SegmentDuration = 6
					tm, err := NewTranscodeManager(t.TempDir(), cfg)
					if err != nil {
						t.Fatalf("new transcode manager: %v", err)
					}
					t.Cleanup(tm.Close)
					s, v := startFirstVariant(t, tm, src, SessionOpts{
						SourceVideoCodec: "h264", AudioTrackIndex: -1, AudioChannels: 2,
						Remux: true, RemuxAudioCopy: true, StartSec: startSec,
					})
					if !s.Remux {
						t.Fatalf("session was promoted to a transcode; the case needs a remux")
					}

					published, ok := publishedMediaStart(t, servePlaylist(t, tm, s, v))
					if !ok {
						t.Fatalf("remux at start_sec=%d published no media start", startSec)
					}
					shown := firstFrameSourceSec(t, v.OutputDir)
					t.Logf("start_sec=%d first frame shows %.3fs, published media start %.3fs (gap %.3fs)",
						startSec, shown, published, float64(startSec)-published)

					// Within a few frames of the picture: ffprobe reports the
					// earliest presentation time across streams, which an AAC
					// packet can precede the key frame by.
					if d := published - shown; d > 0.1 || d < -0.25 {
						t.Errorf("published media start %.3fs but the first frame shows %.3fs (off by %+.3fs)",
							published, shown, d)
					}
					// The case only means something if the copy really began
					// before the anchor; 15 s on this grid must land on 10 s.
					if startSec == 15 && published > 10.1 {
						t.Errorf("start_sec=15 on a 10 s GOP published %.3fs; expected the key frame at 10 s", published)
					}
					// Stable across reloads: one measurement per session.
					again, ok := publishedMediaStart(t, servePlaylist(t, tm, s, v))
					if !ok || again != published {
						t.Errorf("second playlist load published %v (ok=%v), first %v", again, ok, published)
					}
				})
			}
		}
	}
}

// A transcode seeks accurately — its media time 0 IS start_sec — and a remux
// from 0 seeks nowhere. Neither may publish a media start: the client then
// keeps start_sec, i.e. its clock does not move.
func TestRemuxMediaStart_TranscodeAndUnseekedSessionsPublishNothing(t *testing.T) {
	requireFFmpeg(t)
	src := barcodeFixture(t, "mkv", "aac", 10, 30)
	for _, tc := range []struct {
		name     string
		remux    bool
		startSec int
	}{
		{name: "transcode mid-file", remux: false, startSec: 15},
		{name: "remux from zero", remux: true, startSec: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tm := newMatrixManager(t)
			s, v := startFirstVariant(t, tm, src, SessionOpts{
				SourceVideoCodec: "h264", AudioTrackIndex: -1, AudioChannels: 2,
				Remux: tc.remux, RemuxAudioCopy: tc.remux, StartSec: tc.startSec,
			})
			body := servePlaylist(t, tm, s, v)
			if sec, ok := publishedMediaStart(t, body); ok {
				t.Fatalf("%s published a media start of %.3fs:\n%s", tc.name, sec, body)
			}
			if tc.remux {
				return
			}
			// And the reason it may not: the transcode really does begin at
			// start_sec.
			if shown := firstFrameSourceSec(t, v.OutputDir); shown < float64(tc.startSec)-0.05 || shown > float64(tc.startSec)+0.1 {
				t.Errorf("transcode at start_sec=%d begins at %.3fs; accurate seek should land on it", tc.startSec, shown)
			}
		})
	}
}

// fakeMediaStartSession builds a remux session whose variant playlist is
// already on disk, without FFmpeg.
func fakeMediaStartSession(t *testing.T, tm *TranscodeManager, startSec int, playlist string) (*TranscodeSession, *QualityVariant) {
	t.Helper()
	id := fmt.Sprintf("sess-media-start-%d", time.Now().UnixNano())
	varDir := filepath.Join(tm.baseDir, id, "source")
	if err := os.MkdirAll(varDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(varDir, variantPlaylistName), []byte(playlist), 0o640); err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{})
	close(ready)
	v := &QualityVariant{Profile: QualityProfile{Name: "source"}, OutputDir: varDir, Ready: ready, started: true}
	s := &TranscodeSession{
		ID: id, OutputDir: filepath.Join(tm.baseDir, id),
		Variants: map[string]*QualityVariant{"source": v}, Profiles: []QualityProfile{{Name: "source"}},
		LastAccess: time.Now(), Remux: true, StartSec: startSec,
	}
	tm.mu.Lock()
	tm.sessions[s.ID] = s
	tm.mu.Unlock()
	return s, v
}

const mediaStartPlaylist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n" +
	"#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nseg_00000.ts\n"

func TestSessionMediaStart_ProbesOnceAndBoundsWhatItPublishes(t *testing.T) {
	newTM := func(t *testing.T, probe func(context.Context, string, bool) (float64, error)) *TranscodeManager {
		tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "ts"})
		if err != nil {
			t.Fatalf("new transcode manager: %v", err)
		}
		t.Cleanup(tm.Close)
		tm.mediaStartProbe = probe
		return tm
	}

	t.Run("one probe per session, reused on every reload", func(t *testing.T) {
		var calls atomic.Int32
		tm := newTM(t, func(context.Context, string, bool) (float64, error) { calls.Add(1); return 19.946009, nil })
		s, v := fakeMediaStartSession(t, tm, 25, mediaStartPlaylist)
		for i := 0; i < 3; i++ {
			body := servePlaylist(t, tm, s, v)
			if !strings.Contains(body, "#EXT-X-MEDIA-SEQUENCE:0\n#AURORA-MEDIA-START:19.946009\n#EXTINF:10.0,\nseg_00000.ts\n") ||
				!strings.HasPrefix(body, "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n") {
				t.Fatalf("load %d: media start not right before the first segment:\n%s", i, body)
			}
		}
		if n := calls.Load(); n != 1 {
			t.Errorf("probed %d times across 3 loads, want 1", n)
		}
	})

	// M2: a start that only appears on a later reload moves the clock under a
	// viewer already watching. Every retry happens inside the FIRST request.
	t.Run("transient failures are retried within the first request, never after it", func(t *testing.T) {
		var calls atomic.Int32
		tm := newTM(t, func(context.Context, string, bool) (float64, error) { calls.Add(1); return 0, errors.New("busy") })
		s, v := fakeMediaStartSession(t, tm, 25, mediaStartPlaylist)
		if _, ok := publishedMediaStart(t, servePlaylist(t, tm, s, v)); ok {
			t.Fatal("published a media start the probe never produced")
		}
		if n := calls.Load(); n != mediaStartMaxAttempts {
			t.Fatalf("first request probed %d times, want all %d attempts inside it", n, mediaStartMaxAttempts)
		}
		for i := 0; i < 3; i++ {
			if _, ok := publishedMediaStart(t, servePlaylist(t, tm, s, v)); ok {
				t.Fatal("a later reload published a media start")
			}
		}
		if n := calls.Load(); n != mediaStartMaxAttempts {
			t.Errorf("later reloads probed again: %d probes in all", n)
		}
	})

	t.Run("a failure recovered within the first request is published by it", func(t *testing.T) {
		var calls atomic.Int32
		tm := newTM(t, func(context.Context, string, bool) (float64, error) {
			if calls.Add(1) < mediaStartMaxAttempts {
				return 0, errors.New("segment still flushing")
			}
			return 19.946009, nil
		})
		s, v := fakeMediaStartSession(t, tm, 25, mediaStartPlaylist)
		if sec, ok := publishedMediaStart(t, servePlaylist(t, tm, s, v)); !ok || sec != 19.946009 {
			t.Fatalf("first request published %v (ok=%v), want the retried measurement", sec, ok)
		}
	})

	for _, tc := range []struct {
		name     string
		startSec int
		measured float64
	}{
		{"after the anchor: not one -noaccurate_seek produced", 25, 31},
		{"more than a minute before the anchor", 3600, 3600 - mediaStartMaxLagSec - 1},
		{"negative", 25, -0.5},
	} {
		t.Run("implausible start is final: "+tc.name, func(t *testing.T) {
			var calls atomic.Int32
			tm := newTM(t, func(context.Context, string, bool) (float64, error) { calls.Add(1); return tc.measured, nil })
			s, v := fakeMediaStartSession(t, tm, tc.startSec, mediaStartPlaylist)
			for i := 0; i < 2; i++ {
				if sec, ok := publishedMediaStart(t, servePlaylist(t, tm, s, v)); ok {
					t.Fatalf("published %.3fs for start_sec=%d", sec, tc.startSec)
				}
			}
			if n := calls.Load(); n != 1 {
				t.Errorf("an implausible answer is final, probed %d times", n)
			}
		})
	}
	t.Run("the edges of the window are published", func(t *testing.T) {
		for _, measured := range []float64{3600 - mediaStartMaxLagSec, 3600 + mediaStartMaxLeadSec} {
			tm := newTM(t, func(context.Context, string, bool) (float64, error) { return measured, nil })
			s, v := fakeMediaStartSession(t, tm, 3600, mediaStartPlaylist)
			if sec, ok := publishedMediaStart(t, servePlaylist(t, tm, s, v)); !ok || sec != measured {
				t.Errorf("measured %.3f for start_sec=3600: published %v (ok=%v)", measured, sec, ok)
			}
		}
	})

	// L1: no request holds a lock across the probe.
	t.Run("concurrent fetches wait together, not in turn", func(t *testing.T) {
		const probeTime = 600 * time.Millisecond
		var calls atomic.Int32
		tm := newTM(t, func(ctx context.Context, _ string, _ bool) (float64, error) {
			calls.Add(1)
			select {
			case <-time.After(probeTime):
				return 19.946009, nil
			case <-ctx.Done():
				return 0, ctx.Err()
			}
		})
		s, _ := fakeMediaStartSession(t, tm, 25, mediaStartPlaylist)
		const fetches = 4
		bodies := make(chan string, fetches)
		began := time.Now()
		var wg sync.WaitGroup
		for i := 0; i < fetches; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				rec := httptest.NewRecorder()
				tm.ServeVariantPlaylist(rec, httptest.NewRequest("GET", "/x", nil), s.ID, "source", "")
				bodies <- rec.Body.String()
			}()
		}
		wg.Wait()
		close(bodies)
		if took := time.Since(began); took > probeTime+400*time.Millisecond {
			t.Errorf("%d concurrent fetches took %v behind one %v probe: they queued", fetches, took, probeTime)
		}
		for body := range bodies {
			if _, ok := publishedMediaStart(t, body); !ok {
				t.Errorf("a concurrent fetch was served without the measurement:\n%s", body)
			}
		}
		if n := calls.Load(); n != 1 {
			t.Errorf("probed %d times for %d concurrent fetches, want 1", n, fetches)
		}
	})

	t.Run("a hung probe costs each fetch the budget, not more", func(t *testing.T) {
		tm := newTM(t, func(ctx context.Context, _ string, _ bool) (float64, error) {
			<-ctx.Done()
			return 0, ctx.Err()
		})
		s, v := fakeMediaStartSession(t, tm, 25, mediaStartPlaylist)
		began := time.Now()
		var wg sync.WaitGroup
		for i := 0; i < 3; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); servePlaylist(t, tm, s, v) }()
		}
		wg.Wait()
		if took := time.Since(began); took > mediaStartBudget+time.Second {
			t.Errorf("3 fetches behind a hung probe took %v; the budget is %v", took, mediaStartBudget)
		}
		// The measurement itself gave up inside the budget: the next fetch
		// finds it settled instead of paying the wait again.
		next := time.Now()
		if _, ok := publishedMediaStart(t, servePlaylist(t, tm, s, v)); ok {
			t.Fatal("published a measurement from a probe that never answered")
		}
		if took := time.Since(next); took > 200*time.Millisecond {
			t.Errorf("a fetch after the budget waited %v: the hung probe was never bounded", took)
		}
	})

	t.Run("a cancelled request does not cancel the measurement", func(t *testing.T) {
		var calls atomic.Int32
		release := make(chan struct{})
		tm := newTM(t, func(ctx context.Context, _ string, _ bool) (float64, error) {
			calls.Add(1)
			select {
			case <-release:
				return 19.946009, nil
			case <-ctx.Done():
				return 0, ctx.Err()
			}
		})
		s, v := fakeMediaStartSession(t, tm, 25, mediaStartPlaylist)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		// Straight at the wait: through ServeVariantPlaylist, its own select on
		// Ready vs the cancelled context would pick either at random.
		began := time.Now()
		if _, ok := tm.sessionMediaStart(ctx, s, v, "seg_00000.ts"); ok {
			t.Fatal("a cancelled request waited for and got the measurement")
		}
		if took := time.Since(began); took > 500*time.Millisecond {
			t.Errorf("a cancelled request still waited %v for the probe", took)
		}
		close(release)
		if sec, ok := publishedMediaStart(t, servePlaylist(t, tm, s, v)); !ok || sec != 19.946009 {
			t.Fatalf("the next request got %v (ok=%v); the measurement died with the cancelled one", sec, ok)
		}
		if n := calls.Load(); n != 1 {
			t.Errorf("probed %d times, want 1", n)
		}
	})

	t.Run("a playlist not starting at segment 0 is not measured", func(t *testing.T) {
		tm := newTM(t, func(context.Context, string, bool) (float64, error) {
			t.Error("probed a playlist whose first segment is not segment 0")
			return 0, nil
		})
		s, v := fakeMediaStartSession(t, tm, 25, strings.Replace(mediaStartPlaylist, "seg_00000.ts", "seg_00007.ts", 1))
		if _, ok := publishedMediaStart(t, servePlaylist(t, tm, s, v)); ok {
			t.Fatal("published a media start for a playlist that does not begin at segment 0")
		}
	})

	t.Run("transcode and unseeked sessions are never probed", func(t *testing.T) {
		tm := newTM(t, func(context.Context, string, bool) (float64, error) {
			t.Error("probed a session whose clock must not move")
			return 0, nil
		})
		transcode, tv := fakeMediaStartSession(t, tm, 25, mediaStartPlaylist)
		transcode.Remux = false
		fromZero, zv := fakeMediaStartSession(t, tm, 0, mediaStartPlaylist)
		for _, c := range []struct {
			s *TranscodeSession
			v *QualityVariant
		}{{transcode, tv}, {fromZero, zv}} {
			if _, ok := publishedMediaStart(t, servePlaylist(t, tm, c.s, c.v)); ok {
				t.Fatalf("session %s published a media start", c.s.ID)
			}
		}
	})
}

// The probe's limits are what keep it cheap on a 40 Mbps segment (1 MB and
// 1 s returned the same start as no limits at all, in review). Nothing else
// fails without them, so pin the exact command line a stand-in ffprobe sees.
func TestProbeMediaStartSec_PassesItsProbeLimits(t *testing.T) {
	bin := t.TempDir()
	argsFile := filepath.Join(t.TempDir(), "args")
	stub := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$AURORA_FAKE_FFPROBE_ARGS\"\necho 19.946000\n"
	if err := os.WriteFile(filepath.Join(bin, "ffprobe"), []byte(stub), 0o755); err != nil {
		t.Fatalf("write ffprobe stub: %v", err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("AURORA_FAKE_FFPROBE_ARGS", argsFile)

	dir := t.TempDir()
	for _, tc := range []struct {
		fmp4  bool
		input string
	}{
		{false, filepath.Join(dir, "seg_00000.ts")},
		{true, "concat:" + filepath.Join(dir, "init.mp4") + "|" + filepath.Join(dir, "seg_00000.m4s")},
	} {
		sec, err := probeMediaStartSec(context.Background(), dir, tc.fmp4)
		if err != nil || sec != 19.946 {
			t.Fatalf("fmp4=%v: probe = %v, %v; want 19.946", tc.fmp4, sec, err)
		}
		raw, err := os.ReadFile(argsFile)
		if err != nil {
			t.Fatalf("fmp4=%v: the stand-in ffprobe did not run: %v", tc.fmp4, err)
		}
		got := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
		want := []string{
			"-v", "error",
			"-probesize", "1000000",
			"-analyzeduration", "1000000",
			"-show_entries", "format=start_time",
			"-of", "default=noprint_wrappers=1:nokey=1",
			tc.input,
		}
		if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
			t.Fatalf("fmp4=%v: ffprobe argv\n got %q\nwant %q", tc.fmp4, got, want)
		}
	}
}

// The subtitle endpoint's media_start= (ParseClientMediaStart): the value a
// client read from #AURORA-MEDIA-START, accepted only as a plain decimal and
// only inside the window the line is published under for that start_sec.
func TestParseClientMediaStart(t *testing.T) {
	for _, tc := range []struct {
		raw      string
		startSec int
		want     float64
		ok       bool
	}{
		// Used at 10 ms (each distinct shift is a cached VTT per track): to the
		// nearest hundredth, whatever precision arrives.
		{"19.946009", 25, 19.95, true},
		{"19.944", 25, 19.94, true},
		{"19.95", 25, 19.95, true},
		{"19.9549", 25, 19.95, true},
		{"19.9451", 25, 19.95, true},
		{mediaStartLine(9.960000)[len(mediaStartTagPrefix):], 20, 9.96, true}, // exactly what the playlist carries
		{"20", 20, 20, true},
		// The window judges the value sent; rounding then lands on its edge at
		// most, never past it.
		{"3540.004", 3600, 3540, true},
		{"3600.999", 3600, 3601, true},
		{"3539.996", 3600, 0, false},
		{"0", 5, 0, true}, // a copy from the very first key frame
		{"0.000000", 5, 0, true},
		// The window's edges are in, one microsecond past each is out.
		{"3540", 3600, 3540, true},
		{"3601", 3600, 3601, true},
		{"3539.999999", 3600, 0, false},
		{"3601.000001", 3600, 0, false},
		// Not a plain decimal: never parsed, whatever it would evaluate to.
		{"", 25, 0, false},
		{"abc", 25, 0, false},
		{"NaN", 25, 0, false},
		{"Inf", 25, 0, false},
		{"+Inf", 25, 0, false},
		{"-1", 25, 0, false},
		{"-0", 25, 0, false},
		{"+20", 25, 0, false},
		{"2e1", 25, 0, false},
		{"0x1p4", 25, 0, false},
		{"20.", 25, 0, false},
		{".5", 1, 0, false},
		{"20.0.0", 25, 0, false},
		{" 20", 25, 0, false},
		{"20 ", 25, 0, false},
		{"2_0", 25, 0, false},
		{strings.Repeat("9", 400), 25, 0, false}, // out of float64 range
	} {
		got, ok := ParseClientMediaStart(tc.raw, tc.startSec)
		if ok != tc.ok || got != tc.want {
			t.Errorf("ParseClientMediaStart(%q, %d) = %v, %v; want %v, %v", tc.raw, tc.startSec, got, ok, tc.want, tc.ok)
		}
	}
}

func TestProbeMediaStartSec_RefusesAConcatSeparatorInThePath(t *testing.T) {
	if _, err := probeMediaStartSec(context.Background(), "/tmp/a|b", true); err == nil {
		t.Fatal("a '|' in an fMP4 segment path must not reach the concat protocol")
	}
}
