package streaming

// Real-FFmpeg coverage for the reap/resume path.
//
// Everything else that exercises resumePoint feeds it hand-written playlists.
// That pins the arithmetic but not the thing the arithmetic exists for: that a
// variant stopped mid-encode and relaunched at the computed anchor produces ONE
// continuous timeline — no dropped span, no re-appended GOP, no duplicated
// segment numbers. Whether that holds depends on how FFmpeg actually
// interprets -ss, -start_number and +append_list together, which no argument
// test can observe.
//
// The gap mattered: the playlist-name bug meant the playlist-preferred anchor
// never executed in production at all, so its first real exercise should not be
// someone's movie.

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

var segURIRe = regexp.MustCompile(`(?m)^seg_(\d+)\.(?:ts|m4s)$`)

// playlistSegmentNumbers returns the segment numbers a playlist publishes, in
// the order they appear.
func playlistSegmentNumbers(t *testing.T, playlistPath string) []int {
	t.Helper()
	body, err := os.ReadFile(playlistPath)
	if err != nil {
		t.Fatalf("read playlist: %v", err)
	}
	var out []int
	for _, m := range segURIRe.FindAllStringSubmatch(string(body), -1) {
		n, convErr := strconv.Atoi(m[1])
		if convErr != nil {
			t.Fatalf("unparsable segment number %q", m[1])
		}
		out = append(out, n)
	}
	return out
}

// rollbackToSegments rewinds a finished variant's output to the state the idle
// sweep would have left it in had it cancelled FFmpeg after `keep` segments:
// the playlist truncated to those entries with no ENDLIST, and every later
// segment gone from disk.
//
// Done this way rather than by racing a real cancel because the race is not
// controllable — an unpaced remux publishes a 30s fixture faster than a test
// can react, which lands every join on the final segment where an anchor error
// has no room to show. The bytes left behind are FFmpeg's own, including its
// real EXTINF values; only where the encoder stopped is synthetic.
func rollbackToSegments(t *testing.T, v *QualityVariant, keep int) {
	t.Helper()
	playlist := filepath.Join(v.OutputDir, variantPlaylistName)
	body, err := os.ReadFile(playlist)
	if err != nil {
		t.Fatalf("read playlist for rollback: %v", err)
	}

	var kept []string
	var pendingEXTINF string
	published := 0
	for _, line := range strings.Split(string(body), "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "#EXT-X-ENDLIST":
			continue // the encoder was killed, not finished
		case strings.HasPrefix(trimmed, "#EXTINF:"):
			pendingEXTINF = line // hold until its URI proves it is kept
			continue
		case segURIRe.MatchString(trimmed):
			if published >= keep {
				pendingEXTINF = ""
				continue
			}
			published++
			if pendingEXTINF != "" {
				kept = append(kept, pendingEXTINF)
				pendingEXTINF = ""
			}
			kept = append(kept, line)
			continue
		}
		kept = append(kept, line)
	}
	if published != keep {
		t.Fatalf("rollback wanted %d segments, playlist held %d", keep, published)
	}
	if err := os.WriteFile(playlist, []byte(strings.Join(kept, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("rewrite truncated playlist: %v", err)
	}

	entries, err := os.ReadDir(v.OutputDir)
	if err != nil {
		t.Fatalf("read variant dir: %v", err)
	}
	for _, ent := range entries {
		numStr, ok := segmentNumberPart(ent.Name())
		if !ok {
			continue
		}
		n, convErr := strconv.Atoi(numStr)
		if convErr != nil || n < keep {
			continue
		}
		if err := os.Remove(filepath.Join(v.OutputDir, ent.Name())); err != nil {
			t.Fatalf("remove segment %s: %v", ent.Name(), err)
		}
	}
}

// waitForExitLocked is waitForFFmpegExit with the session lock held around the
// read, and it surfaces FFmpeg's stderr the way the shared helper does.
//
// The lock covers v.exited, which IS written under variantMu. The other half —
// ffmpegDone reaching into Cmd.ProcessState, written inside os/exec.(*Cmd).Wait
// under no lock at all — was the reason this file still added race reports, and
// it has since been fixed where the comment here said it wanted fixing: in
// ffmpegDone itself, which no longer consults exec.Cmd at all. The lock stays
// because reading v.exited without it would be a race in its own right.
func waitForExitLocked(t *testing.T, s *TranscodeSession, v *QualityVariant, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		s.variantMu.Lock()
		done, encErr, tail := ffmpegDone(v), v.Err, v.StderrTail
		s.variantMu.Unlock()
		if done {
			// A resumed FFmpeg that dies at launch would otherwise be reported
			// as a huge "SKIPPED", blaming the anchor for a process failure.
			if encErr != nil {
				t.Fatalf("ffmpeg exited with an error: %v\nstderr tail:\n%s", encErr, tail)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	// Under the lock like every other read of this field: the timeout path is
	// the one place a stranded variant is still being written to by the
	// cmd.Wait goroutine, so reading it bare would report a race here and send
	// whoever is debugging after that instead of the regression that caused
	// the timeout.
	s.variantMu.Lock()
	tail := v.StderrTail
	s.variantMu.Unlock()
	t.Fatalf("ffmpeg did not exit within %v\nstderr tail:\n%s", within, tail)
}

// segmentStartSec reports where a segment's media actually begins on the
// session timeline, via ffprobe. This is what makes a skip distinguishable
// from a duplicate: total published duration cannot tell them apart, because
// skipping a segment moves the total DOWN toward the source duration and so
// looks better than a correct resume that re-delivers a GOP.
func segmentStartSec(t *testing.T, variantDir, segName string) float64 {
	t.Helper()
	probe := filepath.Join(variantDir, segName)

	// A CMAF fragment carries no codec configuration of its own, so ffprobe
	// cannot open it alone — the init segment has to be prepended, exactly as
	// a player concatenates them. (measurePeakSegmentBitrate sidesteps this by
	// never probing the fragment; here the timeline is the whole point.)
	if init, err := os.ReadFile(filepath.Join(variantDir, "init.mp4")); err == nil {
		frag, ferr := os.ReadFile(probe)
		if ferr != nil {
			t.Fatalf("read fragment %s: %v", segName, ferr)
		}
		joined := filepath.Join(t.TempDir(), "probe.mp4")
		if werr := os.WriteFile(joined, append(init, frag...), 0o644); werr != nil {
			t.Fatalf("join init+fragment: %v", werr)
		}
		probe = joined
	}

	out, err := exec.Command("ffprobe", "-v", "error",
		"-show_entries", "format=start_time", "-of", "csv=p=0", probe).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", segName, err)
	}
	v, perr := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if perr != nil {
		t.Fatalf("unparsable start_time %q for %s", out, segName)
	}
	return v
}

// TestPlaybackMatrix_ReapAndResumeRejoinsTheTimeline stops a variant where the
// idle sweep would, resumes it the way EnsureVariant does, and measures the
// resulting playlist against the source it was made from.
//
// The remux case is the load-bearing one. A transcode is re-encoded under
// -force_key_frames, so its segments are exactly SegmentDuration and the old
// segIndex*SegmentDuration anchor is accidentally correct — that path cannot
// tell the fix from the bug however it is fixtured. A remux copies the source
// GOP, so a 2.5s key-frame cadence against a 2s target yields 2.5s segments and
// the nominal arithmetic drifts 0.5s per segment. Both run: remux to catch the
// anchor, transcode to prove the join stays contiguous on the accurate-seek
// side.
func TestPlaybackMatrix_ReapAndResumeRejoinsTheTimeline(t *testing.T) {
	requireFFmpeg(t)
	requireFFmpegEncoders(t, "libx264", "aac")

	const (
		durationSec = 30.0
		fps         = 24
		// 2.5s key-frame cadence against matrixConfig's 2s SegmentDuration.
		// hlsenc cuts at the first key frame at or past 2s, so a remux
		// publishes 2.5s segments and the nominal arithmetic is wrong by 20%.
		gopFrames   = 60
		reapAfter   = 6
		remuxSegSec = 2.5
	)

	for _, tc := range []struct {
		name  string
		remux bool
		// slack is the tolerance on total published duration. The remux side
		// is looser because its -noaccurate_seek input seek lands wherever the
		// demuxer's key-frame search puts it, and on a container without
		// AVFMT_SEEK_TO_PTS (Matroska here) the target is shifted 130ms early
		// before that search even starts — a documented limit no anchor
		// arithmetic can close. One GOP covers it; the anchor errors this
		// guards against are larger.
		slack float64
	}{
		{name: "remux", remux: true, slack: remuxSegSec + 0.5},
		{name: "transcode", remux: false, slack: 1.0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := mediaFixture{
				Container: "mkv", VideoCodec: "h264", AudioCodec: "aac",
				DurationSec: durationSec, FPS: fps, GOP: gopFrames,
			}
			path := fixture.build(t)

			tm := newMatrixManager(t)
			opts := SessionOpts{
				SourceVideoCodec: "h264",
				AudioTrackIndex:  -1,
				AudioChannels:    2,
				Remux:            tc.remux,
				RemuxAudioCopy:   tc.remux,
			}
			session, variant := startFirstVariant(t, tm, path, opts)
			playlist := filepath.Join(variant.OutputDir, variantPlaylistName)

			waitForExitLocked(t, session, variant, 180*time.Second)
			full := publishedPlaylistDuration(t, playlist)
			if full < durationSec-1.0 {
				t.Fatalf("first pass published only %.3fs of a %.1fs source; the fixture or the "+
					"encode is wrong before the resume is even exercised", full, durationSec)
			}

			// Rewind to the post-reap state and mark the variant as the sweep
			// leaves it.
			rollbackToSegments(t, variant, reapAfter)
			atReap := publishedPlaylistDuration(t, playlist)
			session.variantMu.Lock()
			variant.reaped = true
			variant.exited = true
			session.variantMu.Unlock()

			if _, err := tm.EnsureVariant(session, variant.Profile.Name, session.StartSec); err != nil {
				t.Fatalf("resume after reap: %v", err)
			}
			waitForExitLocked(t, session, variant, 180*time.Second)

			final := playlistSegmentNumbers(t, playlist)
			published := publishedPlaylistDuration(t, playlist)
			t.Logf("%s: full %.3fs -> rolled back to %d segments (%.3fs) -> resumed to %d segments (%.3fs); source %.1fs",
				tc.name, full, reapAfter, atReap, len(final), published, durationSec)

			if len(final) <= reapAfter {
				t.Fatalf("resume published nothing beyond the rollback point (%d segments)", len(final))
			}

			assertPlaylistSequences(t, tm, session, variant, 0)

			// WHERE the resumed media begins is the assertion that matters,
			// and total duration cannot substitute for it. The band around
			// source duration is direction-blind: skipping a segment moves the
			// total DOWN toward the source and reads as healthier than a
			// correct resume, which on MKV re-delivers a GOP and overshoots.
			// A +2.5s anchor error — one whole segment of the movie missing —
			// published 29.961s against a 30.0s source and passed.
			firstResumed := fmt.Sprintf("seg_%05d%s", final[reapAfter], segExt(session))
			startedAt := segmentStartSec(t, variant.OutputDir, firstResumed)

			t.Logf("%s: first resumed segment %s starts at %.3fs; coverage at rollback was %.3fs",
				tc.name, firstResumed, startedAt, atReap)

			// Never past the rollback point: that is content the viewer never
			// receives. The small forward allowance is rounding, not a span.
			if startedAt > atReap+0.25 {
				t.Errorf("resume began at %.3fs but coverage ended at %.3fs — %.3fs of the source "+
					"is missing from this tier%s",
					startedAt, atReap, startedAt-atReap, anchorHint(tc.remux, atReap, reapAfter, true))
			}
			// Behind by at most one GOP. Remux legitimately lands a GOP early
			// (see slack); anything beyond that is an anchor error.
			if behind := atReap - startedAt; behind > tc.slack {
				t.Errorf("resume began at %.3fs, %.3fs behind the %.3fs coverage point — more than "+
					"the one-GOP re-delivery the demuxer's seek accounts for%s",
					startedAt, behind, atReap, anchorHint(tc.remux, atReap, reapAfter, false))
			}

			// Aggregate sanity, kept loose on purpose: it catches a resume
			// that ran away entirely, while the assertions above own
			// direction.
			if published < durationSec-tc.slack-1.0 || published > durationSec+tc.slack+1.0 {
				t.Errorf("published %.3fs from a %.1fs source (first pass published %.3fs)",
					published, durationSec, full)
			}
		})
	}
}

// Pin FFmpeg's real append_list semantics through EnsureVariant and the HTTP
// serving path. The retained fragments must keep their sequence AND bytes
// across a deliberate idle reap, a crash, and the missing-playlist fallback.
func TestPlaybackMatrix_ResumePreservesMediaSequences(t *testing.T) {
	requireFFmpeg(t)
	requireFFmpegEncoders(t, "libx264", "aac")
	for _, remux := range []bool{false, true} {
		for _, format := range []string{"ts", "fmp4"} {
			t.Run(fmt.Sprintf("remux_%t/%s", remux, format), func(t *testing.T) {
				path := (mediaFixture{Container: "mp4", DurationSec: 20, FPS: 24, GOP: 48}).build(t)
				cfg := matrixConfig()
				cfg.SegmentFormat = format
				tm, err := NewTranscodeManager(t.TempDir(), cfg)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(tm.Close)
				s, v := startFirstVariant(t, tm, path, SessionOpts{
					SourceVideoCodec: "h264", AudioTrackIndex: -1, AudioChannels: 2,
					Remux: remux, RemuxAudioCopy: remux,
				})
				waitForExitLocked(t, s, v, 30*time.Second)
				assertPlaylistSequences(t, tm, s, v, 0)
				for resume, keep := range []int{4, 6, 8} {
					rollbackToSegments(t, v, keep)
					preserved := make(map[string][32]byte)
					for _, num := range playlistSegmentNumbers(t, filepath.Join(v.OutputDir, variantPlaylistName)) {
						name := fmt.Sprintf("seg_%05d%s", num, segExt(s))
						data, err := os.ReadFile(filepath.Join(v.OutputDir, name))
						if err != nil {
							t.Fatal(err)
						}
						preserved[name] = sha256.Sum256(data)
					}
					if resume == 2 {
						if err := os.Remove(filepath.Join(v.OutputDir, variantPlaylistName)); err != nil {
							t.Fatal(err)
						}
					}
					s.variantMu.Lock()
					v.reaped = resume != 1
					if resume == 1 {
						v.Err = errors.New("synthetic crash after published segment")
					}
					s.variantMu.Unlock()
					if _, err := tm.EnsureVariant(s, v.Profile.Name, s.StartSec); err != nil {
						t.Fatalf("resume %d: %v", resume+1, err)
					}
					waitForExitLocked(t, s, v, 30*time.Second)
					first := 0
					if resume == 2 {
						first = keep
					}
					assertPlaylistSequences(t, tm, s, v, first)
					for name, oldHash := range preserved {
						data, err := os.ReadFile(filepath.Join(v.OutputDir, name))
						if err != nil {
							t.Fatal(err)
						}
						if sha256.Sum256(data) != oldHash {
							t.Errorf("resume %d overwrote %s", resume+1, name)
						}
					}
					if nums := playlistSegmentNumbers(t, filepath.Join(v.OutputDir, variantPlaylistName)); nums[len(nums)-1] < keep {
						t.Fatalf("resume %d produced no new segment: %v", resume+1, nums)
					}
				}
			})
		}
	}
}

func assertPlaylistSequences(t *testing.T, tm *TranscodeManager, s *TranscodeSession, v *QualityVariant, first int) {
	t.Helper()
	r := httptest.NewRecorder()
	tm.ServeVariantPlaylist(r, httptest.NewRequest("GET", "/stream.m3u8", nil), s.ID, v.Profile.Name, "")
	if r.Code != 200 {
		t.Fatalf("serve resumed playlist: %d %s", r.Code, r.Body.String())
	}
	body := r.Body.String()
	if !strings.Contains(body, fmt.Sprintf("#EXT-X-MEDIA-SEQUENCE:%d\n", first)) {
		t.Fatalf("media sequence does not match first filename %d:\n%s", first, body)
	}
	segments := segURIRe.FindAllStringSubmatch(body, -1)
	if len(segments) == 0 {
		t.Fatal("served playlist has no segments")
	}
	for i, m := range segments {
		n, _ := strconv.Atoi(m[1])
		if n != first+i {
			t.Fatalf("sequence %d maps to filename %d:\n%s", first+i, n, body)
		}
	}
}

// anchorHint spells out what the nominal arithmetic would have produced, so a
// failure names the likely cause rather than only the symptom. skipped picks
// the wording: the old arithmetic seeks EARLY, which duplicates — so on a skip
// it is evidence against that cause, not for it.
func anchorHint(remux bool, publishedSec float64, segs int, skipped bool) string {
	if !remux {
		return "."
	}
	nominal := float64(segs) * float64(matrixConfig().SegmentDuration)
	if skipped {
		return fmt.Sprintf(" — note the nominal arithmetic (%.3fs vs real %.3fs) seeks EARLY, "+
			"so this is not that: look for the anchor landing past the playlist tail.",
			nominal, publishedSec)
	}
	return fmt.Sprintf(" — real coverage was %.3fs but segIndex*SegmentDuration says %.3fs, "+
		"so an anchor computed the old way seeks %.3fs early.",
		publishedSec, nominal, publishedSec-nominal)
}

// segExt is the segment extension the session's muxer writes.
func segExt(s *TranscodeSession) string {
	if s.FMP4 {
		return ".m4s"
	}
	return ".ts"
}
