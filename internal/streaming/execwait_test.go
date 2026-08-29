package streaming

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

// stubExecutable puts a script of the given name at the front of PATH.
func stubExecutable(t *testing.T, name, body string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatalf("write %s stub: %v", name, err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// lingerAndExit runs body, leaves a grandchild holding the inherited stdout and
// stderr, and exits 0. That grandchild is the whole hazard: os/exec copies
// captured output through pipes, so Wait blocks until every holder of those
// descriptors closes them — not until the process exits — and nothing bounds
// how long a grandchild lives.
func lingerAndExit(body string) string {
	return fmt.Sprintf("%s( sleep %d ) &\nexit 0\n", body, lingerSleepSecs)
}

// BOTH of these have to track execWaitDelay, or the timing assertions quietly
// stop meaning anything: they exist to tell a bounded call (returns at
// execWaitDelay) from an unbounded one (which waits out the grandchild), so the
// budget must sit strictly between the two. Pinning one to a literal while
// deriving the other is what breaks that — a fixed 5s linger against an
// execWaitDelay raised to 5s makes every assertion below a tautology. Spaced a
// full delay apart in each direction so a loaded runner has room: a bounded
// call lands at 1×, the budget is 2×, the grandchild leaves at 3×.
const (
	lingerFor    = 3 * execWaitDelay
	lingerBudget = 2 * execWaitDelay
)

// What the stub ACTUALLY sleeps, and therefore the only number the assertions
// may reason about. POSIX sh `sleep` takes whole seconds, so lingerFor has to
// be rounded — UP, because rounding down can reach zero, and a stub that sleeps
// 0 leaves no grandchild, produces no ErrWaitDelay, and turns every linger test
// below into a green vacuum. TestLingerBudgetSeparatesBoundedFromUnbounded pins
// the resulting relation.
var (
	lingerSleepSecs = int(math.Ceil(lingerFor.Seconds()))
	lingerSleep     = time.Duration(lingerSleepSecs) * time.Second
)

// assertBoundedWait checks BOTH ends of what a bounded wait on a real lingering
// pipe looks like, and the lower end is the one that is easy to leave out.
//
// Upper: the call stopped at the bound instead of waiting the grandchild out.
//
// Lower: it did not return early — which would mean the stub left no grandchild
// at all, so no descriptor outlived the process, no ErrWaitDelay was ever
// produced, and every verdict the caller goes on to assert is vacuous. That is
// not hypothetical: each of these tests has a control leg that runs exactly
// that fixture and satisfies the same verdicts. Sound as a bound because the
// WaitDelay timer starts no earlier than process exit and Go timers do not fire
// early, so a genuine ErrWaitDelay run cannot come in under execWaitDelay.
func assertBoundedWait(t *testing.T, elapsed time.Duration, what string) {
	t.Helper()
	if elapsed < execWaitDelay {
		t.Fatalf("%s returned in %s, inside the %s bound: the stub left no lingering pipe, so ErrWaitDelay "+
			"was never exercised and this test is proving nothing", what, elapsed, execWaitDelay)
	}
	if elapsed >= lingerBudget {
		t.Errorf("%s took %s — it waited the grandchild out instead of stopping at the %s bound",
			what, elapsed, execWaitDelay)
	}
}

// The guard on the guards: whatever execWaitDelay is tuned to, a bounded call
// must finish inside lingerBudget and an unbounded one must not. Asserted
// against lingerSleep — the rounded value the shell really gets — not against
// lingerFor, or the rounding could break the separation without failing here.
func TestLingerBudgetSeparatesBoundedFromUnbounded(t *testing.T) {
	if !(execWaitDelay < lingerBudget && lingerBudget < lingerSleep) {
		t.Fatalf("execWaitDelay=%s lingerBudget=%s grandchild sleeps %s: the budget must sit strictly between "+
			"the bound and the grandchild, or the timing assertions cannot fail", execWaitDelay, lingerBudget, lingerSleep)
	}
}

// A stub listing shaped like the real thing: "<flags> <name> <description>".
const stubEncoderListing = "cat <<'LISTING'\n" +
	"Encoders:\n" +
	" V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC\n" +
	" V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)\n" +
	"LISTING\n"

// The boot path's own version of the hang runProbeFFmpegDiag already guards.
// ffmpegHasEncoder runs from NewTranscodeManager twice over (DetectHWAccel and
// ProbeHEVCEncoder), so an unbounded Wait here is a server that never finishes
// starting.
//
// Both verdicts are asserted against the SAME listing with and without the
// lingering grandchild, because the decision this pins is that the grandchild
// changes nothing: ErrWaitDelay means the process exited 0 and CombinedOutput
// returns what it collected, so the listing is scanned rather than discarded.
//
// The "absent" case is the one with teeth. ffmpegHasEncoder answers TRUE on
// error, so treating ErrWaitDelay as a failure would report an encoder the
// build lacks as present — and the "listed" case would keep passing, since
// both readings answer true there. It stays for the timing assertion and as
// the control that a lingering pipe does not flip a positive either.
func TestFFmpegHasEncoder_ALingeringPipeChangesNeitherVerdictNorWait(t *testing.T) {
	cases := []struct {
		name    string
		encoder string
		want    bool
	}{
		{"listed", "h264_nvenc", true},
		{"absent from the listing", "h264_amf", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stubExecutable(t, "ffmpeg", stubEncoderListing+"exit 0\n")
			if got := ffmpegHasEncoder(tc.encoder); got != tc.want {
				t.Fatalf("control (no lingering pipe): got %v, want %v", got, tc.want)
			}

			stubExecutable(t, "ffmpeg", lingerAndExit(stubEncoderListing))
			start := time.Now()
			got := ffmpegHasEncoder(tc.encoder)
			elapsed := time.Since(start)

			if got != tc.want {
				t.Errorf("a grandchild holding the pipe changed the verdict: got %v, want %v", got, tc.want)
			}
			assertBoundedWait(t, elapsed, "the encoder listing")
		})
	}
}

// The drain bound and the process bound are different bounds. This pins the
// drain one: FFmpeg exits 0, a grandchild keeps the pipe, and the probe must
// still answer from the banner it already printed. The context on that command
// would not have helped — cancelling kills the process, and the descriptor is
// held by someone else — just as WaitDelay would not have helped had FFmpeg
// itself hung, since Wait never reaches the drain until the process is reaped.
// That second case is the context's job and is not exercised here: asserting it
// would mean waiting out hwProbeTimeout.
func TestFFmpegSupportsReadrate_ALingeringPipeKeepsTheAnswer(t *testing.T) {
	const banner = "echo 'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers'\n"

	stubExecutable(t, "ffmpeg", banner+"exit 0\n")
	if !ffmpegSupportsReadrate() {
		t.Fatal("control (no lingering pipe): version 6 must enable readrate pacing")
	}

	stubExecutable(t, "ffmpeg", lingerAndExit(banner))
	start := time.Now()
	got := ffmpegSupportsReadrate()
	elapsed := time.Since(start)

	if !got {
		t.Error("a grandchild holding the pipe turned readrate pacing off")
	}
	assertBoundedWait(t, elapsed, "the version probe")
}

// Off the boot path, the same reading has teeth of its own: ErrWaitDelay means
// FFmpeg exited 0, so the .vtt it just wrote is complete. Treating it as a
// failure would delete a good extraction — up to ten minutes of reading through
// a container — and 500 the request that asked for it.
func TestExtractSubtitleVTT_LingeringPipeKeepsTheExtraction(t *testing.T) {
	// Writes WEBVTT to the last argument (ffmpeg's output path), then leaves a
	// grandchild on the pipe.
	stubExecutable(t, "ffmpeg", lingerAndExit(
		"for a in \"$@\"; do out=\"$a\"; done\n"+
			"printf 'WEBVTT\\n\\n' > \"$out\"\n"))

	start := time.Now()
	vtt, err := ExtractSubtitleVTT(context.Background(), "/nonexistent/movie.mkv", 2, t.TempDir())
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("extraction that exited 0 reported failure: %v", err)
	}
	assertBoundedWait(t, elapsed, "the extraction")
	info, statErr := os.Stat(vtt)
	if statErr != nil {
		t.Fatalf("the extracted subtitle was deleted: %v", statErr)
	}
	if info.Size() == 0 {
		t.Fatal("the extracted subtitle is empty")
	}
}

// ---------------------------------------------------------------------------
// Source guards. The behavioral tests above pin how ONE captured-output command
// behaves; these pin that every other one in the package goes through the same
// helper, which is the part that silently rots as call sites are added.

// Every non-test file in the package must capture output through the bounded
// helpers. A bare cmd.Output()/cmd.CombinedOutput() is the exact shape of the
// bug: both attach writers, both therefore let Wait outlive the process, and
// neither carries a WaitDelay of its own.
//
// A text scan, so it is deliberately over-eager: any `.Output()` in the package
// trips it, including one on a type with nothing to do with os/exec. Exempt
// such a line with the marker below, never the whole file — a file-wide
// exemption would also blind this to every real exec capture in it, which is
// the one place the guard has to work. It misses what any text scan misses: a
// call split across lines, a method value passed elsewhere (execwait.go's own
// `cmd.Output` reads that way, which is why the helpers need no exemption).
func TestNoUnboundedOutputCapture(t *testing.T) {
	const allow = "execwait:ok" // last resort, on the offending line

	forEachPackageSource(t, func(t *testing.T, file, src string) {
		for i, line := range strings.Split(src, "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "//") || strings.Contains(line, allow) {
				continue
			}
			for _, call := range []string{".CombinedOutput()", ".Output()"} {
				if strings.Contains(line, call) {
					t.Errorf("%s:%d captures output with a bare %s — use boundedOutput/boundedCombinedOutput (execwait.go), "+
						"or Wait can block for as long as any subprocess holds the inherited descriptors", file, i+1, call)
				}
			}
		}
	})
}

// The counterpart for the two commands that attach their own writers instead of
// capturing (hwdecode.go's stderr tail, streaming.go's variant FFmpeg): the
// contract is identical, so the file must set a WaitDelay somewhere.
//
// Weaker than it looks, in both directions, so take it for what it is.
//
// It under-reaches: it is a FILE-level check, so it cannot tell WHICH cmd in a
// file got the WaitDelay — it catches a new attaching command in a file that
// has none (the realistic drift), not a second one added to streaming.go. And
// being line-anchored on an assignment, it misses a writer attached in a
// composite literal (`&exec.Cmd{Stderr: buf}`).
//
// It also over-reaches, in two ways. It matches an assignment to ANY field
// named Stdout/Stderr on any type, so an unrelated struct in a file with no
// WaitDelay would fail with an exec-specific message. And even on a real
// exec.Cmd it cannot see that `cmd.Stdout = os.Stdout` needs no bound at all:
// os/exec passes an *os.File straight through, so there is no pipe to wait on.
// That direction is the safe one to be wrong in, and the fix is then to look at
// the line rather than to loosen the pattern.
//
// The bounded helpers are what make the common case unmissable; this is only
// the backstop for the two sites that hand-roll their own writers (hwdecode.go's
// stderr tail, streaming.go's variant FFmpeg), where the contract is identical.
func TestFilesThatAttachPipesBoundTheWait(t *testing.T) {
	// [\w.]+ so a qualified target (v.Cmd.Stderr) is not missed, and [^=\n]
	// rather than [^=] because a negated class matches newlines — with [^=]
	// the pattern could run past the end of a line that merely READS from
	// os.Stderr and pick up an unrelated `=` further down the file.
	attaches := regexp.MustCompile(`(?m)^\s*[\w.]+\.Std(out|err)\b[^=\n]*=`)
	// The ASSIGNMENT, not the word: a comment discussing WaitDelay (there are
	// several) must not be able to satisfy this. And the assignment has to set
	// a BOUND — `WaitDelay = 0` is os/exec's "wait forever", i.e. the very bug,
	// spelled in a way that would otherwise read as a fix.
	//
	// Only the literal 0 is rejected, so an indirect zero (a variable, or
	// time.Duration(0)) would still read as bounded; and only an assignment
	// written in the file counts, so routing the bound through a helper — the
	// pattern execwait.go uses for the capture sites — would fail a correct
	// file. Both are why this is a backstop and not the mechanism.
	bounds := regexp.MustCompile(`(?m)^\s*[\w.]+\.WaitDelay\s*=\s*([^\s;/]+)`)

	forEachPackageSource(t, func(t *testing.T, file, src string) {
		loc := attaches.FindStringIndex(src)
		if loc == nil {
			return
		}
		bounded := false
		for _, m := range bounds.FindAllStringSubmatch(src, -1) {
			if m[1] != "0" {
				bounded = true
				break
			}
		}
		if !bounded {
			line := 1 + strings.Count(src[:loc[0]], "\n")
			t.Errorf("%s:%d attaches a writer to a command's Stdout/Stderr but nothing in the file sets a "+
				"non-zero WaitDelay — Wait will then block until every holder of those descriptors closes "+
				"them, however long that takes", file, line)
		}
	})
}

func forEachPackageSource(t *testing.T, check func(t *testing.T, file, src string)) {
	t.Helper()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob package sources: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("no package sources found; this guard would pass vacuously")
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		check(t, file, string(src))
	}
}

// ---------------------------------------------------------------------------

// The variant FFmpeg's own ErrWaitDelay reading, which is the one place in this
// package where getting it wrong is a user-visible regression rather than a
// misjudged probe.
//
// A remux copies faster than realtime, so its FFmpeg routinely runs to EOF and
// exits cleanly mid-viewing, having written a complete VOD playlist. If a
// descendant is still holding stderr at that moment, Wait reports ErrWaitDelay
// instead of nil — and startVariantImpl must NOT record that as a crash.
// v.Err is exactly what EnsureVariant reads to tell a clean completion from a
// mid-stream death (streaming.go, issues #172/#174): a non-nil Err there sends
// a FINISHED transcode down the restart path, relaunching FFmpeg with -ss past
// the end of the file, which produces nothing and then 500s every later
// playlist fetch — the Chromecast break those issues were filed for.
func TestStartVariant_LingeringPipeIsNotACrash(t *testing.T) {
	base := t.TempDir()
	// Built BEFORE the stub is on PATH: its startup probes would each linger
	// out their own WaitDelay otherwise, for nothing this test is asking about.
	tm, err := NewTranscodeManager(base, config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	// Writes a playlist wherever FFmpeg was told to put one, so the readiness
	// poller sees output, then leaves a grandchild holding stderr and exits 0.
	stubExecutable(t, "ffmpeg", lingerAndExit(
		"for a in \"$@\"; do case \"$a\" in *stream.m3u8) printf '#EXTM3U\\n#EXT-X-ENDLIST\\n' > \"$a\";; esac; done\n"))

	outDir := filepath.Join(base, "variant")
	if err := os.MkdirAll(outDir, 0o750); err != nil {
		t.Fatalf("create variant dir: %v", err)
	}
	v := &QualityVariant{
		Profile:   QualityProfile{Name: "source"},
		OutputDir: outDir,
		Ready:     make(chan struct{}),
	}
	session := &TranscodeSession{
		ID:              "sess-linger",
		FilePath:        filepath.Join(base, "movie.mkv"),
		OutputDir:       base,
		Variants:        map[string]*QualityVariant{"source": v},
		LastAccess:      time.Now(),
		Remux:           true,
		AudioTrackIndex: -1,
	}

	start := time.Now()
	session.variantMu.Lock() // startVariant's contract
	err = tm.startVariant(session, v, 0)
	session.variantMu.Unlock()
	if err != nil {
		t.Fatalf("startVariant: %v", err)
	}

	// The Wait goroutine returns one WaitDelay after FFmpeg exits.
	deadline := time.Now().Add(4 * lingerFor)
	for {
		session.variantMu.Lock()
		done := v.exited
		session.variantMu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the cmd.Wait goroutine never finished; a held descriptor is pinning it")
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Not just "did it finish" — WHEN. Without this the test passes against an
	// unbounded variant (cmd.WaitDelay left at 0), because the grandchild does
	// eventually exit and the mapping below is never reached with anything to
	// map. A real held descriptor never exits, and then the goroutine is pinned
	// for good: v.exited, v.Err and v.StderrTail are never written, while
	// ffmpegDone still reports true from Cmd.ProcessState, so EnsureVariant
	// serves a crashed transcode as a clean completion.
	assertBoundedWait(t, time.Since(start), "the variant's cmd.Wait")

	session.variantMu.Lock()
	gotErr := v.Err
	session.variantMu.Unlock()
	if gotErr != nil {
		t.Fatalf("a variant that exited 0 was recorded as crashed: %v", gotErr)
	}

	// And the consequence that actually reaches a viewer: EnsureVariant must
	// serve the finished variant, not restart it past EOF.
	got, err := tm.EnsureVariant(session, "source", 0)
	if err != nil {
		t.Fatalf("EnsureVariant on a completed variant: %v", err)
	}
	if got != v {
		t.Fatal("EnsureVariant returned a different variant")
	}
	if v.restartAttempts != 0 {
		t.Errorf("restartAttempts = %d, want 0 — a clean completion must not be restarted", v.restartAttempts)
	}
}
