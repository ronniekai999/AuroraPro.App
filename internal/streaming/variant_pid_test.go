package streaming

import (
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

// ListSessions used to read a variant's PID straight off its *exec.Cmd
// (v.Cmd.Process.Pid). `started` is set BEFORE cmd.Start() runs, so an admin
// loading the active-streams page while a transcode was spinning up read
// exec.Cmd's fields while the launch goroutine was writing them — a genuine
// data race, and one that holding variantMu could not close, because the
// writer is inside os/exec and holds nothing of ours. `go test -race` caught
// it through TestCreateCastToken_MintAloneDoesNotLease.
//
// The Cmd is no longer reachable from the variant at all, so the compiler —
// not these tests — is what stops the next reader from reaching through it.
// What the tests pin is the replacement: which variants contribute a PID, and
// that the launch goroutine actually publishes one.

// The read side. A variant that has not reached the publish contributes no
// PID; one that has is what /proc gets sampled from.
func TestListSessions_SamplesProcessesFromThePublishedPID(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("NewTranscodeManager: %v", err)
	}
	t.Cleanup(tm.Close)

	tm.mu.Lock()
	tm.sessions["s"] = &TranscodeSession{
		ID:         "s",
		StartedAt:  time.Now().Add(-time.Minute),
		LastAccess: time.Now(),
		Variants: map[string]*QualityVariant{
			// Running: Start() returned and the goroutine published its PID.
			// Our own PID stands in for FFmpeg's so /proc actually resolves.
			"1080p": {Profile: QualityProfile{Name: "1080p"}, started: true, pid: os.Getpid()},
			// Mid-launch: `started` is already true, the fork/exec has not
			// finished. This is the window the race lived in.
			"720p": {Profile: QualityProfile{Name: "720p"}, started: true},
			// Never launched — an ABR rung nobody fetched.
			"480p": {Profile: QualityProfile{Name: "480p"}},
		},
	}
	tm.mu.Unlock()

	infos := tm.ListSessions()
	if len(infos) != 1 {
		t.Fatalf("ListSessions returned %d sessions, want 1", len(infos))
	}
	got := infos[0]

	active := map[string]bool{}
	for _, name := range got.ActiveVariants {
		active[name] = true
	}
	if !active["1080p"] || !active["720p"] {
		t.Errorf("ActiveVariants = %v, want both started variants listed", got.ActiveVariants)
	}
	if active["480p"] {
		t.Errorf("ActiveVariants = %v, want the unlaunched variant left out", got.ActiveVariants)
	}

	if got.Resources == nil {
		t.Fatal("Resources is nil — the published PID never reached the /proc sampler")
	}
	if got.Resources.NumProcesses != 1 {
		t.Errorf("NumProcesses = %d, want 1: only the variant past cmd.Start() has a PID to sample",
			got.Resources.NumProcesses)
	}
	// NumProcesses is just len(pids), so it stays 1 even for a PID that
	// resolves to nothing. Sampling a PID we know is alive is what proves the
	// value reached /proc rather than merely being counted.
	if runtime.GOOS == "linux" && got.Resources.MemoryBytes <= 0 {
		t.Errorf("MemoryBytes = %d for a live PID, want > 0 — the PID was counted but never sampled",
			got.Resources.MemoryBytes)
	}
}

// The write side, which the read-side test above cannot see: startVariantImpl
// publishes v.pid from the launch goroutine only once cmd.Start() has
// returned, and relaunchVariantLocked clears it. Neither is covered by
// anything else in the package — drop either and the whole suite still passes
// while the admin Active-Streams panel silently loses its CPU/RSS numbers for
// every live transcode, or keeps reporting a PID whose process already died.
func TestStartVariant_PublishesThePIDAndRelaunchClearsIt(t *testing.T) {
	fakeFFmpegOnPath(t) // stub: Start() succeeds, the process then exits 1
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	v := &QualityVariant{
		Profile:   QualityProfile{Name: "source"},
		OutputDir: t.TempDir(),
		Ready:     make(chan struct{}),
	}
	s := &TranscodeSession{
		ID:         "sess-pid",
		FilePath:   "/tmp/x.mkv",
		Variants:   map[string]*QualityVariant{"source": v},
		LastAccess: time.Now(),
		Remux:      true,
	}

	if _, err := tm.EnsureVariant(s, "source", 0); err != nil {
		t.Fatalf("EnsureVariant: %v", err)
	}

	// The publish is asynchronous — it happens in the launch goroutine after
	// Start() returns, which is precisely why it cannot be read off the Cmd.
	pid := waitForVariantPID(t, s, v)
	if pid == os.Getpid() {
		t.Fatalf("published pid %d is our own process, not the spawned ffmpeg", pid)
	}

	// The reset must travel with the relaunch. Reading it while we still hold
	// variantMu is deterministic: the relaunched generation's goroutine cannot
	// publish its own PID until we let go of the lock.
	s.variantMu.Lock()
	relaunchErr := tm.relaunchVariantLocked(s, v, 0, 0)
	pidAfter := v.pid
	s.variantMu.Unlock()
	if relaunchErr != nil {
		t.Fatalf("relaunchVariantLocked: %v", relaunchErr)
	}
	if pidAfter != 0 {
		t.Errorf("pid = %d immediately after relaunch, want 0 — a resumed variant would keep "+
			"reporting the PID of the process that already died", pidAfter)
	}
}

// `exited` is the only "this process is gone" signal there is now, and it is
// published after cmd.Wait returns. Attaching a writer to Stderr makes Wait
// block until every holder of the child's stderr descriptor closes it — so an
// FFmpeg that leaves that fd to a subprocess would, without variantWaitDelay,
// keep Wait (and therefore `exited`) pending for as long as the subprocess
// lives. The variant would be stranded: EnsureVariant hands back the zombie on
// every poll, and once the reaper marks it `reaped` the resume branch requires
// ffmpegDone and can never fire again.
//
// The stub exits 0 immediately but leaves a background child holding stderr
// well past the delay. The bound must win, and the resulting ErrWaitDelay must
// NOT be recorded as a crash: the process succeeded, and EnsureVariant answers
// a crash by restarting FFmpeg with -ss past EOF (issues #172/#174).
func TestStartVariant_StalledStderrPipeStillMarksTheVariantExited(t *testing.T) {
	shrinkVariantWaitDelay(t)
	// Writing the playlist first puts the polling goroutine on its
	// playlist-found branch, where it records no Err of its own. That leaves
	// v.Err saying exactly one thing: whether the post-Wait block called the
	// stalled pipe a crash. The child need only outlive the deadline below.
	s, v := stubVariantLaunch(t, "sess-stalled-pipe",
		"    touch \"$out/stream.m3u8\"\n"+
			"    sleep 8 &\n"+
			"    exit 0\n")

	// Comfortably past variantWaitDelay and comfortably short of the child's
	// lifetime, so an unbounded Wait fails here rather than passing slowly.
	deadline := time.Now().Add(variantWaitDelay + 4*time.Second)
	for {
		s.variantMu.Lock()
		done, vErr := ffmpegDone(v), v.Err
		s.variantMu.Unlock()
		if done {
			if vErr != nil {
				t.Fatalf("a clean exit whose stderr pipe outlived the delay was recorded as a crash: %v", vErr)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("variant never reached exited: cmd.Wait is still draining a stderr pipe " +
				"held open by a subprocess, and nothing else can mark this variant done")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The other direction of the same decision, and the one with more to lose: the
// stalled-pipe carve-out must not swallow a real crash. If it ever did, the
// variant would publish `exited` with a nil Err, EnsureVariant would read that
// as a clean completion and hand back the dead variant, and neither the P3
// auto-restart nor the 500 that triggers the frontend's own recovery would
// happen — playback simply stops at the crash point. That is issues #172/#174
// with the sign flipped, and it would not show up in any other test here.
//
// The crash comes WITH a stalled pipe, because that combination is the only
// state in which the carve-out could mask a crash — and it is the state a
// plausible refactor gets wrong. Deriving `pipeStalled` from elapsed time
// rather than from the error, say, still satisfies a crash-without-stall test
// and a stall-without-crash test while swallowing exactly this case. Wait
// gives Process.Wait's error precedence, so ErrWaitDelay cannot accompany a
// non-zero exit: the crash must survive the stall.
func TestStartVariant_RealCrashIsStillRecordedAsOne(t *testing.T) {
	shrinkVariantWaitDelay(t)
	const marker = "aurora-test-crash-marker"
	// Playlist first, so Err can only have come from the post-Wait block.
	s, v := stubVariantLaunch(t, "sess-real-crash",
		"    touch \"$out/stream.m3u8\"\n"+
			"    echo '"+marker+"' >&2\n"+
			"    sleep 8 &\n"+
			"    exit 1\n")

	deadline := time.Now().Add(variantWaitDelay + 4*time.Second)
	for {
		s.variantMu.Lock()
		done, vErr := ffmpegDone(v), v.Err
		s.variantMu.Unlock()
		if done {
			if vErr == nil {
				t.Fatal("ffmpeg exited 1 but the variant reports no error — EnsureVariant will " +
					"read this as a clean completion and serve the dead variant")
			}
			if !strings.Contains(vErr.Error(), marker) {
				t.Errorf("v.Err = %v, want the FFmpeg stderr tail carried along with it", vErr)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("variant never reached exited after ffmpeg exited 1")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The third arm of the same decision. A variant the idle reaper cancels dies
// by SIGKILL, so cmd.Wait reports "signal: killed" — a non-nil error that must
// NOT become v.Err, because nothing crashed. EnsureVariant's reaped branch
// recovers playback either way, but ServeVariantPlaylist and ServeHLSSegment
// snapshot v.Err without going through it, and would 500 every fetch between
// the reap and the next playlist poll while the diagnose surface reported a
// crash that never happened.
//
// `exec sleep`, not `sleep`, so the shell replaces itself: the cancel then
// kills the process that holds the pipe rather than leaving an orphan.
func TestStartVariant_ReaperCancelIsNotRecordedAsACrash(t *testing.T) {
	shrinkVariantWaitDelay(t)
	s, v := stubVariantLaunch(t, "sess-cancelled",
		"    touch \"$out/stream.m3u8\"\n"+
			"    exec sleep 30\n")

	// Wait for the PID before cancelling. The launch is asynchronous, and a
	// cancel that lands before cmd.Start() takes the Start-failure path
	// instead — which sets v.Err and never sets `exited` at all (see the note
	// on that path in startVariantImpl), so the reap this test is about would
	// never happen.
	waitForVariantPID(t, s, v)

	s.variantMu.Lock()
	cancel := v.Cancel
	s.variantMu.Unlock()
	if cancel == nil {
		t.Fatal("variant has no Cancel — the reaper would have nothing to call")
	}
	cancel()

	deadline := time.Now().Add(variantWaitDelay + 4*time.Second)
	for {
		s.variantMu.Lock()
		done, vErr := ffmpegDone(v), v.Err
		s.variantMu.Unlock()
		if done {
			if vErr != nil {
				t.Fatalf("a cancelled variant recorded an error: %v — a reap is a deliberate "+
					"stop, and every v.Err reader will report it as a failed transcode", vErr)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("cancelled variant never reached exited")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// shrinkVariantWaitDelay drops the stderr-drain bound for one test. The
// stalled-pipe cases have to wait it out, and at the shipped 5s that is most
// of the package's test time. The callers above still bound their own
// deadlines by variantWaitDelay, so what they pin is the mechanism — that the
// drain is bounded at all, and what the resulting error means — not the chosen
// value.
//
// What makes this write safe is NOT that these tests are serial: the restore
// below runs at test end, while a launch goroutine from that same test may
// still be alive. It is that production reads the var on the caller's
// goroutine only — the cmd.WaitDelay assignment in startVariantImpl, which
// EnsureVariant runs synchronously — and every later reader uses
// cmd.WaitDelay, which the launch goroutine owns. A launch-goroutine read of
// the var would race with the restore, and -race would blame whichever test
// was running when it fired rather than this one.
func shrinkVariantWaitDelay(t *testing.T) {
	t.Helper()
	prev := variantWaitDelay
	variantWaitDelay = 500 * time.Millisecond
	t.Cleanup(func() { variantWaitDelay = prev })
}

// stubVariantLaunch puts a stub ffmpeg on PATH, launches one variant through
// the real EnsureVariant path, and returns its session and variant.
//
// `arm` is the shell run for the VARIANT launch only, with "$out" bound to the
// variant's output directory. Scoping it that way matters: NewTranscodeManager
// probes ffmpeg too, and one of those probes — ffmpegHasEncoder
// (hwaccel.go), reached via encoderAvailable — reads it through
// CombinedOutput with no WaitDelay, so a stub that stalls there stalls
// startup instead of the thing under test. (The HEVC test encode beside it
// is bounded: runProbeFFmpegDiag sets one.) Probe invocations fall through
// to `exit 1`, which is what fakeFFmpegOnPath does for every call.
func stubVariantLaunch(t *testing.T, sessionID, arm string) (*TranscodeSession, *QualityVariant) {
	t.Helper()
	outDir := t.TempDir()
	// $out is quoted at every use: a TMPDIR containing a space or a glob
	// character would otherwise silently mis-target the playlist and fail this
	// test for a reason that has nothing to do with the code under test.
	stubFFmpeg(t, "out='"+outDir+"'\n"+
		"case \"$*\" in\n"+
		"  *\"$out\"*)\n"+
		arm+
		"    ;;\n"+
		"esac\n"+
		"exit 1\n")

	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)

	v := &QualityVariant{
		Profile:   QualityProfile{Name: "source"},
		OutputDir: outDir,
		Ready:     make(chan struct{}),
	}
	s := &TranscodeSession{
		ID:         sessionID,
		FilePath:   "/tmp/x.mkv",
		Variants:   map[string]*QualityVariant{"source": v},
		LastAccess: time.Now(),
		Remux:      true,
	}
	if _, err := tm.EnsureVariant(s, "source", 0); err != nil {
		t.Fatalf("EnsureVariant: %v", err)
	}
	return s, v
}

// waitForVariantPID blocks until the launch goroutine has published a PID for
// v, honouring ffmpegDone's contract of reading variant state under variantMu.
func waitForVariantPID(t *testing.T, s *TranscodeSession, v *QualityVariant) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s.variantMu.Lock()
		pid := v.pid
		s.variantMu.Unlock()
		if pid != 0 {
			return pid
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("launch goroutine never published a PID — ListSessions has nothing to sample /proc with")
	return 0
}
