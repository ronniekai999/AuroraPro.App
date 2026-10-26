package api

// The sidecar subtitle cue shift for a session started mid-file
// (ServeSubtitle, subtitleCueShift), against real FFmpeg output.
//
// A remux seeks with -ss <start_sec> -noaccurate_seek. On Matroska with
// B-frames, a start_sec ON a key frame makes FFmpeg's seek land 130 ms early,
// on the PREVIOUS key frame, so the copy begins a whole GOP before the key
// frame ProbeSeekKeyframe predicts. The cue shift used that prediction, so
// every cue showed a GOP early. The session measures where it really began
// (#AURORA-MEDIA-START, internal/streaming/media_start.go); a client that
// sends it back as media_start= must get exactly that shift.
//
// "Where the picture is" comes from the frames themselves: the fixture writes
// each frame's own number as a bar code, so decoding the first frame FFmpeg
// wrote says which source second the player's media time 0 shows, independent
// of every timestamp involved. A cue at source second C is shown at media time
// C - shift, when the picture shows firstFrame + C - shift, so it is off by
// firstFrame - shift (negative: early).

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/streaming"
)

// requireShiftMediaTools skips without ffmpeg/ffprobe, or fails when
// AURORA_REQUIRE_MEDIA_TESTS is set (CI), as internal/streaming's
// requireFFmpeg does.
func requireShiftMediaTools(t *testing.T) {
	t.Helper()
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			switch strings.ToLower(strings.TrimSpace(os.Getenv("AURORA_REQUIRE_MEDIA_TESTS"))) {
			case "1", "true", "yes", "on":
				t.Fatalf("%s not in PATH (AURORA_REQUIRE_MEDIA_TESTS is set: media tooling is mandatory here)", bin)
			}
			t.Skipf("%s not in PATH", bin)
		}
	}
}

const (
	shiftBarcodeFPS  = 24
	shiftBarcodeBits = 12
	shiftBarcodeBitW = 26
)

// shiftBarcodeMKV writes a Matroska H.264 (libx264 veryfast: B-frames) + AAC
// file into dir whose every frame carries its own frame number as a 12-bit
// bar code, with a key frame exactly every gopSec seconds and no scene-cut key
// frames. It mirrors internal/streaming's barcodeFixture.
func shiftBarcodeMKV(t *testing.T, dir string, gopSec, durationSec int) string {
	t.Helper()
	out := filepath.Join(dir, "barcode.mkv")
	vf := fmt.Sprintf("color=c=gray:size=320x240:rate=%d:duration=%d,format=yuv420p,"+
		`geq=lum='if(lt(Y\,160)\,if(lt(X\,%d)\,255*mod(floor(N/pow(2\,floor(X/%d)))\,2)\,128)\,128)':cb=128:cr=128`,
		shiftBarcodeFPS, durationSec, shiftBarcodeBits*shiftBarcodeBitW, shiftBarcodeBitW)
	gop := strconv.Itoa(gopSec * shiftBarcodeFPS)
	args := []string{"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", vf,
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=440:duration=%d", durationSec),
		"-map", "0:v", "-map", "1:a",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
		"-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
		"-c:a", "aac", "-ac", "2", out}
	if b, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("generate bar-code fixture: %v\n%s", err, b)
	}
	// The case needs B-frames: they are what moves FFmpeg's Matroska seek
	// target 130 ms early. Without them the prediction would be right.
	probe, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=has_b_frames", "-of", "default=noprint_wrappers=1:nokey=1", out).Output()
	if err != nil {
		t.Fatalf("probe fixture for B-frames: %v", err)
	}
	if n, _ := strconv.Atoi(strings.TrimSpace(string(probe))); n <= 0 {
		t.Fatalf("fixture has no B-frames (has_b_frames=%q); the case needs them", strings.TrimSpace(string(probe)))
	}
	return out
}

// shiftFirstFrameSourceSec decodes the first frame of a variant's first
// segment and returns the source second its bar code names.
func shiftFirstFrameSourceSec(t *testing.T, variantDir string) float64 {
	t.Helper()
	init, err := os.ReadFile(filepath.Join(variantDir, "init.mp4"))
	if err != nil {
		t.Fatalf("read init segment: %v", err)
	}
	frag, err := os.ReadFile(filepath.Join(variantDir, "seg_00000.m4s"))
	if err != nil {
		t.Fatalf("read first fragment: %v", err)
	}
	joined := filepath.Join(t.TempDir(), "first.mp4")
	if err := os.WriteFile(joined, append(init, frag...), 0o644); err != nil {
		t.Fatalf("join init+fragment: %v", err)
	}
	raw, err := exec.Command("ffmpeg", "-v", "error", "-i", joined, "-frames:v", "1",
		"-vf", "scale=320:240,format=gray", "-f", "rawvideo", "-").Output()
	if err != nil {
		t.Fatalf("decode first frame: %v", err)
	}
	if len(raw) < 81*320 {
		t.Fatalf("decoded frame too short: %d bytes", len(raw))
	}
	row := raw[80*320 : 81*320]
	n := 0
	for b := 0; b < shiftBarcodeBits; b++ {
		if row[b*shiftBarcodeBitW+shiftBarcodeBitW/2] > 128 {
			n |= 1 << b
		}
	}
	return float64(n) / shiftBarcodeFPS
}

// shiftSession runs a real session over src from startSec (a remux or a
// transcode), serves its first variant playlist through the real path, and
// returns the media start that playlist publishes (ok=false for none) and the
// variant's directory.
func shiftSession(t *testing.T, src string, startSec int, remux bool) (float64, bool, string) {
	t.Helper()
	tm, err := streaming.NewTranscodeManager(t.TempDir(), config.TranscodeConfig{
		MaxSessions: 4, MaxSessionsPerUser: 4, HWAccel: "none", HWDecode: "off",
		SegmentDuration: 6, SegmentFormat: "fmp4", Profiles: []string{"360p"}, SoftwarePreset: "ultrafast",
	})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)
	s, err := tm.CreateSession(1, "subs", src, 320, 240, streaming.SessionOpts{
		SourceVideoCodec: "h264", AudioTrackIndex: -1, AudioChannels: 2,
		Remux: remux, RemuxAudioCopy: remux, StartSec: startSec,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(func() { tm.StopSession(s.ID) })
	if s.Remux != remux {
		t.Fatalf("session remux=%v, want %v", s.Remux, remux)
	}
	profile := s.Profiles[0].Name
	rec := httptest.NewRecorder()
	tm.ServeVariantPlaylist(rec, httptest.NewRequest(http.MethodGet, "/stream.m3u8", nil), s.ID, profile, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("variant playlist: HTTP %d: %s", rec.Code, rec.Body.String())
	}
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		if raw, found := strings.CutPrefix(line, "#AURORA-MEDIA-START:"); found {
			sec, perr := strconv.ParseFloat(raw, 64)
			if perr != nil {
				t.Fatalf("unparsable media start line %q", line)
			}
			return sec, true, filepath.Join(s.OutputDir, profile)
		}
	}
	return 0, false, filepath.Join(s.OutputDir, profile)
}

// firstCueStartSec returns the start time of the first cue in a VTT body.
func firstCueStartSec(t *testing.T, vtt string) float64 {
	t.Helper()
	for _, line := range strings.Split(vtt, "\n") {
		start, _, found := strings.Cut(line, " --> ")
		if !found {
			continue
		}
		parts := strings.Split(strings.TrimSpace(start), ":")
		sec := 0.0
		for _, p := range parts {
			v, err := strconv.ParseFloat(p, 64)
			if err != nil {
				t.Fatalf("unparsable cue time %q", start)
			}
			sec = sec*60 + v
		}
		return sec
	}
	t.Fatalf("no cue in VTT:\n%s", vtt)
	return 0
}

// The cue's source second in every fixture subtitle below.
const shiftCueSourceSec = 25.0

// TestSubtitleCueShift_MatroskaKeyFrameStart is the bug and its fix on real
// FFmpeg output: a 10 s-GOP Matroska file with B-frames, a remux asked for
// 20 s (exactly on a key frame), which really begins at the key frame at 10 s.
func TestSubtitleCueShift_MatroskaKeyFrameStart(t *testing.T) {
	requireShiftMediaTools(t)
	const startSec = 20
	mediaDir := t.TempDir()
	src := shiftBarcodeMKV(t, mediaDir, 10, 40)
	ctx := context.Background()

	published, ok, variantDir := shiftSession(t, src, startSec, true)
	if !ok {
		t.Fatalf("the remux at start_sec=%d published no media start", startSec)
	}
	shown := shiftFirstFrameSourceSec(t, variantDir)
	predicted := streaming.ProbeSeekKeyframe(ctx, src, startSec)
	t.Logf("start_sec=%d: first frame shows %.3fs, published media start %.3fs, ProbeSeekKeyframe predicts %.3fs",
		startSec, shown, published, predicted)
	// The premise: FFmpeg began a whole GOP before the predicted key frame.
	if shown > 10.05 || predicted < 19.95 {
		t.Fatalf("fixture does not reproduce the Matroska case: first frame %.3fs, prediction %.3fs", shown, predicted)
	}
	// The cue error a shift leaves, against the picture (negative: early).
	cueError := func(shift float64) float64 { return shown - shift }
	// Within a few frames: ffprobe's start is the earliest sample across
	// streams, which an AAC packet can lead the key frame by.
	assertOnPicture := func(t *testing.T, shift float64) {
		t.Helper()
		if e := cueError(shift); e < -0.1 || e > 0.25 {
			t.Errorf("shift %.3fs leaves cues %+.3fs off the picture (first frame %.3fs)", shift, e, shown)
		}
	}
	mediaStartParam := strconv.FormatFloat(published, 'f', 6, 64)

	t.Run("a remux with the measured start shifts by it", func(t *testing.T) {
		shift, basis := subtitleCueShift(ctx, src, startSec, true, mediaStartParam)
		if basis != subtitleShiftMeasured || shift != published {
			t.Fatalf("shift = %.6f (%s), want the measured %.6f", shift, basis, published)
		}
		t.Logf("measured: shift %.3fs, cue error %+.3fs", shift, cueError(shift))
		assertOnPicture(t, shift)

		// And the in-memory shift ServeSubtitle serves it with puts the cue
		// there, writing nothing.
		vtt := filepath.Join(t.TempDir(), "cue.vtt")
		if err := os.WriteFile(vtt, []byte("WEBVTT\n\n00:00:25.000 --> 00:00:27.000\nTwenty-five\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		body, _, err := streaming.ShiftedVTT(vtt, shift)
		if err != nil {
			t.Fatalf("shift VTT: %v", err)
		}
		at := firstCueStartSec(t, string(body))
		if d := at - (shiftCueSourceSec - published); d > 0.002 || d < -0.002 {
			t.Errorf("cue at %.3fs of media time, want %.3fs", at, shiftCueSourceSec-published)
		}
		if left, _ := os.ReadDir(filepath.Dir(vtt)); len(left) != 1 {
			t.Errorf("the in-memory shift wrote files beside its source: %v", left)
		}
	})

	t.Run("a remux without a measured start keeps the prediction", func(t *testing.T) {
		// An older client sends no media_start=; so does the web player when
		// its session's playlist carried no measured start.
		shift, basis := subtitleCueShift(ctx, src, startSec, true, "")
		if basis != subtitleShiftPredicted || shift != predicted {
			t.Fatalf("shift = %.3f (%s), want the prediction %.3f", shift, basis, predicted)
		}
		t.Logf("predicted (unchanged fallback): shift %.3fs, cue error %+.3fs — a GOP early on this source", shift, cueError(shift))
	})

	for _, bad := range []string{"abc", "NaN", "Inf", "-1", "1e1", "0x1p4", "21.000001", "-0.5", " 9.96"} {
		t.Run("an unusable media_start keeps the prediction: "+bad, func(t *testing.T) {
			if shift, basis := subtitleCueShift(ctx, src, startSec, true, bad); basis != subtitleShiftPredicted || shift != predicted {
				t.Fatalf("media_start=%q: shift = %.3f (%s), want the prediction %.3f", bad, shift, basis, predicted)
			}
		})
	}

	t.Run("a transcode is unchanged and ignores media_start", func(t *testing.T) {
		if sec, ok, transcodeDir := shiftSession(t, src, startSec, false); ok {
			t.Fatalf("a transcode published a media start of %.3fs", sec)
		} else {
			begins := shiftFirstFrameSourceSec(t, transcodeDir)
			t.Logf("transcode at start_sec=%d: first frame shows %.3fs", startSec, begins)
			for _, param := range []string{"", mediaStartParam} {
				shift, basis := subtitleCueShift(ctx, src, startSec, false, param)
				if basis != subtitleShiftStartSec || shift != startSec {
					t.Fatalf("transcode, media_start=%q: shift = %.3f (%s), want start_sec %d", param, shift, basis, startSec)
				}
				if e := begins - shift; e < -0.05 || e > 0.1 {
					t.Errorf("transcode begins at %.3fs; a shift of %.3fs leaves cues %+.3fs off", begins, shift, e)
				}
			}
		}
	})

	t.Run("no start is no shift", func(t *testing.T) {
		for _, remux := range []bool{false, true} {
			if shift, basis := subtitleCueShift(ctx, src, 0, remux, mediaStartParam); basis != subtitleShiftNone || shift != 0 {
				t.Fatalf("start 0 (remux=%v): shift = %.3f (%s)", remux, shift, basis)
			}
		}
	})

	// The same cases through the real handler, which reads the query: an
	// external SRT beside the file (ConvertSRTtoVTT, no extraction).
	t.Run("through ServeSubtitle", func(t *testing.T) {
		q := requireRequestTestDB(t)
		srt := strings.TrimSuffix(src, filepath.Ext(src)) + ".eng.srt"
		if err := os.WriteFile(srt, []byte("1\n00:00:25,000 --> 00:00:27,000\nTwenty-five\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		ctx := context.Background()
		userID := seedReqUser(t, q)
		profile, err := q.CreateDefaultProfileForUser(ctx, userID, "default")
		if err != nil {
			t.Fatalf("seed default profile: %v", err)
		}
		refreshID := seedRCRefreshToken(t, q, userID)
		if ok, err := q.SetActiveProfileForToken(ctx, refreshID, userID, profile.ID); err != nil || !ok {
			t.Fatalf("bind profile: ok=%v err=%v", ok, err)
		}
		suffix := reqTestSuffix(t)
		lib := &models.Library{Name: "subshift_lib_" + suffix, Type: models.LibraryType("movie"), Paths: []string{mediaDir}, ScanInterval: 60, OwnerID: userID}
		if err := q.CreateLibrary(ctx, lib); err != nil {
			t.Fatalf("create library: %v", err)
		}
		t.Cleanup(func() { _, _ = q.DeleteLibrary(context.Background(), lib.ID) })
		movie := &models.MediaItem{LibraryID: lib.ID, Type: models.MediaMovie, Title: "Subtitle Shift " + suffix, SortTitle: "subtitle shift"}
		if err := q.UpsertMediaItem(ctx, movie); err != nil {
			t.Fatalf("seed movie: %v", err)
		}
		rcDateRows(t, "-30 days", []int64{movie.ID})
		file := &models.MediaFile{MediaItemID: movie.ID, Path: src, FileHash: "subshift-" + suffix, Container: "matroska", VideoCodec: "h264", AudioCodec: "aac"}
		if err := q.UpsertMediaFile(ctx, file); err != nil {
			t.Fatalf("seed movie file: %v", err)
		}
		subCache := t.TempDir()
		h := NewStreamHandler(q, nil, nil, subCache, nil, nil, nil)
		shiftedFiles := func(t *testing.T) []string {
			t.Helper()
			found, err := filepath.Glob(filepath.Join(subCache, "*_shift*ms_*.vtt"))
			if err != nil {
				t.Fatal(err)
			}
			return found
		}

		getTrack := func(t *testing.T, track, query string, header http.Header) *httptest.ResponseRecorder {
			t.Helper()
			r := rcRouteReq(http.MethodGet, "/api/stream/x/subtitles/"+track+"?type=media"+query,
				map[string]string{"fileID": i64(file.ID), "trackIdx": track})
			for k, v := range header {
				r.Header[k] = v
			}
			rr := httptest.NewRecorder()
			h.ServeSubtitle(rr, rcClaimsCtx(r, userID, refreshID))
			return rr
		}
		get := func(t *testing.T, query string, header http.Header) *httptest.ResponseRecorder {
			t.Helper()
			return getTrack(t, "1000", query, header)
		}
		expectTrackCue := func(t *testing.T, track, query string, shift float64) *httptest.ResponseRecorder {
			t.Helper()
			rr := getTrack(t, track, query, nil)
			if rr.Code != http.StatusOK {
				t.Fatalf("%s: HTTP %d: %s", query, rr.Code, rr.Body.String())
			}
			if at := firstCueStartSec(t, rr.Body.String()); at-(shiftCueSourceSec-shift) > 0.002 || at-(shiftCueSourceSec-shift) < -0.002 {
				t.Errorf("%s: cue at %.3fs of media time, want %.3fs (a shift of %.3fs)", query, at, shiftCueSourceSec-shift, shift)
			}
			return rr
		}
		expectCue := func(t *testing.T, query string, shift float64) *httptest.ResponseRecorder {
			t.Helper()
			return expectTrackCue(t, "1000", query, shift)
		}
		start := "&start=" + strconv.Itoa(startSec)

		// The web player's request for this session: on the picture. A
		// client-chosen shift is built per request: distinct values (each
		// one exact) leave no shifted file in the cache.
		measuredResp := expectCue(t, start+"&remux=1&media_start="+mediaStartParam, published)
		for _, other := range []float64{published - 0.004, published + 0.0049, published - 7.25, 0.5} {
			expectCue(t, start+"&remux=1&media_start="+strconv.FormatFloat(other, 'f', 6, 64), other)
		}
		if files := shiftedFiles(t); len(files) != 0 {
			t.Errorf("five media_start values left %d shifted VTTs in the cache, want none: %v", len(files), files)
		}

		// Served as the file path serves a cached shift: the same headers,
		// validators from the source, and a conditional request answered 304.
		// An older client: the prediction, cached exactly as before.
		predictedResp := expectCue(t, start+"&remux=1", predicted)
		expectCue(t, start+"&remux=1&media_start=NaN", predicted)
		for _, name := range []string{"Content-Type", "Cache-Control", "Accept-Ranges"} {
			if got, want := measuredResp.Header().Get(name), predictedResp.Header().Get(name); got != want || want == "" {
				t.Errorf("%s: in-memory %q, cached file %q", name, got, want)
			}
		}
		for _, name := range []string{"ETag", "Last-Modified", "Content-Length"} {
			if measuredResp.Header().Get(name) == "" || predictedResp.Header().Get(name) == "" {
				t.Errorf("%s: in-memory %q, cached file %q; both must send it", name, measuredResp.Header().Get(name), predictedResp.Header().Get(name))
			}
		}
		if got := measuredResp.Header().Get("Content-Length"); got != strconv.Itoa(measuredResp.Body.Len()) {
			t.Errorf("in-memory Content-Length %s for a %d-byte body", got, measuredResp.Body.Len())
		}
		if a, b := measuredResp.Header().Get("ETag"), get(t, start+"&remux=1&media_start=0.500000", nil).Header().Get("ETag"); a == b {
			t.Errorf("two different shifts share the ETag %s", a)
		}
		if again := get(t, start+"&remux=1&media_start="+mediaStartParam, http.Header{"If-None-Match": {measuredResp.Header().Get("ETag")}}); again.Code != http.StatusNotModified {
			t.Errorf("a conditional request for the same in-memory shift: HTTP %d, want 304", again.Code)
		}
		// A transcode: start_sec, with or without a stray media_start.
		expectCue(t, start, startSec)
		expectCue(t, start+"&media_start="+mediaStartParam, startSec)
		// The server-derived shifts (the prediction and start_sec) are the
		// only ones cached: a file per distinct offset, as before.
		wantFiles := map[string]bool{}
		for _, offset := range []float64{predicted, startSec} {
			wantFiles[fmt.Sprintf("_shift%dms_", int64(offset*1000+0.5))] = true
		}
		files := shiftedFiles(t)
		if len(files) != len(wantFiles) {
			t.Errorf("the cache holds %v, want one file per server-derived offset %v", files, wantFiles)
		}
		for _, f := range files {
			if name := filepath.Base(f); !wantFiles[name[strings.Index(name, "_shift"):strings.Index(name, "ms_")+3]] {
				t.Errorf("unexpected shifted file %s", name)
			}
		}
		// No start (direct play): unshifted.
		expectCue(t, "", 0)

		// A source above the in-memory cap: media_start= is set aside for the
		// prediction, through the cache, as before it existed; said once.
		// (A .vtt sidecar is served as is, so its size is the source's.)
		var big strings.Builder
		big.WriteString("WEBVTT\n\nNOTE padding past the in-memory cap\n")
		for big.Len() <= streaming.MaxInMemoryShiftSourceBytes {
			big.WriteString(strings.Repeat("padding ", 12) + "\n")
		}
		big.WriteString("\n00:00:25.000 --> 00:00:27.000\nTwenty-five\n")
		if err := os.WriteFile(strings.TrimSuffix(src, filepath.Ext(src))+".zzz.vtt", []byte(big.String()), 0o644); err != nil {
			t.Fatal(err)
		}
		before := len(shiftedFiles(t))
		logs := captureLogs(t, func() {
			for i := 0; i < 2; i++ {
				expectTrackCue(t, "1001", start+"&remux=1&media_start="+mediaStartParam, predicted)
			}
		})
		if n := strings.Count(logs, "too large to shift in memory"); n != 1 {
			t.Errorf("the cap's fallback was logged %d times over two requests, want once:\n%s", n, logs)
		}
		if !strings.Contains(logs, "level=INFO msg=\"subtitle too large") {
			t.Errorf("the cap's fallback is not an Info line:\n%s", logs)
		}
		if got := len(shiftedFiles(t)); got != before+1 {
			t.Errorf("the capped track's prediction left %d new cached files, want its one", got-before)
		}

		// A measured start at 0 is no shift: the source as is, as for any
		// offset <= 0, not rewritten (which would drop its CRs and the cue
		// ending at zero). Track 1002 sorts after .zzz.vtt.
		raw := "WEBVTT\r\n\r\n00:00:00.000 --> 00:00:00.000\r\nzero\r\n\r\n00:00:25.000 --> 00:00:27.000\r\nTwenty-five\r\n"
		if err := os.WriteFile(strings.TrimSuffix(src, filepath.Ext(src))+".zzzz.vtt", []byte(raw), 0o644); err != nil {
			t.Fatal(err)
		}
		before = len(shiftedFiles(t))
		if rr := getTrack(t, "1002", start+"&remux=1&media_start=0.000000", nil); rr.Code != http.StatusOK || rr.Body.String() != raw {
			t.Errorf("media_start=0: HTTP %d, body %q; want the source untouched", rr.Code, rr.Body.String())
		}
		if got := len(shiftedFiles(t)); got != before {
			t.Errorf("media_start=0 left %d new cached files", got-before)
		}

		// The line for an in-memory shift is written once the response is
		// done, with what was built: here shorter than its source (the cue
		// ending at zero is dropped).
		var shiftedResp *httptest.ResponseRecorder
		logs = captureLogs(t, func() {
			shiftedResp = getTrack(t, "1002", start+"&remux=1&media_start="+mediaStartParam, nil)
		})
		if shiftedResp.Code != http.StatusOK || shiftedResp.Body.Len() >= len(raw) {
			t.Fatalf("in-memory shift of track 1002: HTTP %d, %d bytes from a %d-byte source", shiftedResp.Code, shiftedResp.Body.Len(), len(raw))
		}
		for _, want := range []string{"in_memory=true", "shifted=true", fmt.Sprintf("vtt_bytes=%d\n", shiftedResp.Body.Len())} {
			if !strings.Contains(logs, want) {
				t.Errorf("the served line lacks %q:\n%s", want, logs)
			}
		}
	})
}

// An unusable media_start= is client text, and the prediction's warning logs
// it: bounded, whatever the client sent. (No media needed: the prediction on a
// missing file falls back to start_sec.)
func TestSubtitleCueShift_BoundsTheLoggedMediaStart(t *testing.T) {
	sent := strings.Repeat("9", 40) + strings.Repeat("x", 4096)
	var shift float64
	var basis string
	out := captureLogs(t, func() {
		shift, basis = subtitleCueShift(context.Background(), filepath.Join(t.TempDir(), "missing.mkv"), 20, true, sent)
	})
	if basis != subtitleShiftPredicted || shift != 20 {
		t.Fatalf("shift = %.3f (%s), want the fallback prediction 20", shift, basis)
	}
	if !strings.Contains(out, "media_start="+strings.Repeat("9", 32)+" ") || strings.Contains(out, strings.Repeat("9", 33)) || strings.Contains(out, "9x") {
		t.Errorf("the warning did not log the first 32 characters only:\n%s", out)
	}
	if !strings.Contains(out, "media_start_bytes=4136") {
		t.Errorf("the warning did not log the length sent:\n%s", out)
	}
}
