package streaming

import (
	"fmt"
	"os"
	"path/filepath"
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

// The stalled-pipe case itself — a clean exit whose stderr outlives it — is
// TestStartVariant_LingeringPipeIsNotACrash in execwait_test.go, which arrived
// with the bound. These two cover the arms it does not: a crash that ALSO
// stalls, and a reaper cancel.

// The direction with more to lose: the stalled-pipe carve-out must not swallow
// a real crash. If it ever did, the variant would publish `exited` with a nil
// Err, EnsureVariant would read that as a clean completion and hand back the
// dead variant, and neither the P3 auto-restart nor the 500 that triggers the
// frontend's own recovery would happen — playback simply stops at the crash
// point. That is issues #172/#174 with the sign flipped.
//
// The crash comes WITH a lingering pipe, because that combination is the only
// state in which the carve-out could mask a crash, and it is the state a
// plausible refactor gets wrong: deriving "stalled" from elapsed time rather
// than from the error satisfies both a crash-without-linger test and
// LingeringPipe's clean-exit-with-linger, while swallowing exactly this case.
// Wait gives Process.Wait's error precedence, so ErrWaitDelay cannot accompany
// a non-zero exit — the crash must survive the linger.
func TestStartVariant_RealCrashIsStillRecordedAsOne(t *testing.T) {
	const marker = "aurora-test-crash-marker"
	// Playlist first, so the readiness poller takes its playlist-found branch
	// and writes no Err of its own: v.Err can then only have come from the
	// post-Wait block.
	s, v := stubVariantLaunch(t, "sess-real-crash",
		writePlaylistThen("echo '"+marker+"' >&2\n")+
			fmt.Sprintf("( sleep %d ) &\nexit 1\n", lingerSleepSecs))

	start := time.Now()
	vErr := waitForVariantExit(t, s, v, "ffmpeg exited 1")
	assertBoundedWait(t, time.Since(start), "the variant's cmd.Wait")

	if vErr == nil {
		t.Fatal("ffmpeg exited 1 but the variant reports no error — EnsureVariant will " +
			"read this as a clean completion and serve the dead variant")
	}
	if !strings.Contains(vErr.Error(), marker) {
		t.Errorf("v.Err = %v, want the FFmpeg stderr tail carried along with it", vErr)
	}
}

// The third arm. A variant the idle reaper cancels dies by SIGKILL, so cmd.Wait
// reports "signal: killed" — a non-nil error that must NOT become v.Err,
// because nothing crashed. EnsureVariant's reaped branch recovers playback
// either way, but ServeVariantPlaylist and ServeHLSSegment snapshot v.Err
// without going through it, and would 500 every fetch between the reap and the
// next playlist poll while the diagnose surface reported a crash that never
// happened.
//
// `exec sleep`, not `sleep`, so the shell replaces itself: the cancel then
// kills the process holding the pipe rather than leaving a grandchild behind.
func TestStartVariant_ReaperCancelIsNotRecordedAsACrash(t *testing.T) {
	s, v := stubVariantLaunch(t, "sess-cancelled",
		writePlaylistThen("")+fmt.Sprintf("exec sleep %d\n", lingerSleepSecs))

	// Wait for the stub's playlist before cancelling. The launch is
	// asynchronous, and an early cancel lands in one of two other paths that
	// each set v.Err for a reason this test is not about:
	//   - before cmd.Start(): the Start-failure path, which never sets `exited`
	//     at all (see the note on that path in startVariantImpl), so the reap
	//     this test is about never happens;
	//   - after Start but before the stub has written stream.m3u8 (waiting for
	//     the PID alone left this open, failing ~2% of runs): the readiness
	//     poller sees FFmpeg exit with no playlist and records "exited before
	//     producing playlist" itself, which this test would blame on the
	//     post-Wait block.
	// With the playlist on disk every remaining poller path takes its
	// playlist-found branch — the exit branch re-checks before writing — so, as
	// in TestStartVariant_RealCrashIsStillRecordedAsOne, v.Err can only come
	// from the post-Wait block. The playlist, not Ready, is what is awaited:
	// the poller rechecks only every 500ms, which would add that to every run.
	waitForVariantPlaylist(t, s, v)

	s.variantMu.Lock()
	exited, preErr, cancel := ffmpegDone(v), v.Err, v.Cancel
	s.variantMu.Unlock()
	if exited || preErr != nil {
		t.Fatalf("before the cancel: exited = %v, v.Err = %v; want the stub still running "+
			"with no error recorded", exited, preErr)
	}
	if cancel == nil {
		t.Fatal("variant has no Cancel — the reaper would have nothing to call")
	}
	cancel()

	if vErr := waitForVariantExit(t, s, v, "the variant was cancelled"); vErr != nil {
		t.Fatalf("a cancelled variant recorded an error: %v — a reap is a deliberate "+
			"stop, and every v.Err reader will report it as a failed transcode", vErr)
	}
}

// writePlaylistThen emits the shell that satisfies the readiness poller —
// FFmpeg writes a playlist wherever it was told to put one — followed by body.
// Taken from TestStartVariant_LingeringPipeIsNotACrash so the two agree on what
// a "started" variant looks like.
func writePlaylistThen(body string) string {
	return "for a in \"$@\"; do case \"$a\" in *stream.m3u8) printf '#EXTM3U\\n' > \"$a\";; esac; done\n" + body
}

// waitForVariantExit blocks until the launch goroutine publishes `exited`, then
// returns the variant's error. Reads both under variantMu, per ffmpegDone's
// contract. The budget is the same one execwait_test.go uses to tell a bounded
// wait from an unbounded one, so a lost bound fails here rather than passing
// slowly.
func waitForVariantExit(t *testing.T, s *TranscodeSession, v *QualityVariant, what string) error {
	t.Helper()
	deadline := time.Now().Add(lingerBudget)
	for {
		s.variantMu.Lock()
		done, vErr := ffmpegDone(v), v.Err
		s.variantMu.Unlock()
		if done {
			return vErr
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s, but the variant never reached exited within %s: cmd.Wait is still "+
				"draining a stderr pipe held open by a subprocess, and with the "+
				"Cmd.ProcessState fallback gone nothing else can mark this variant done",
				what, lingerBudget)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// stubVariantLaunch launches one variant through the real EnsureVariant path
// against a stub ffmpeg, and returns its session and variant.
//
// The manager is built BEFORE the stub goes on PATH, as
// TestStartVariant_LingeringPipeIsNotACrash does: its startup probes shell out
// to ffmpeg too, and a stub that lingers would make each of them wait out its
// own bound for nothing these tests are asking about.
func stubVariantLaunch(t *testing.T, sessionID, body string) (*TranscodeSession, *QualityVariant) {
	t.Helper()
	base := t.TempDir()
	tm, err := NewTranscodeManager(base, config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)

	stubExecutable(t, "ffmpeg", body)

	outDir := filepath.Join(base, "variant")
	if err := os.MkdirAll(outDir, 0o750); err != nil {
		t.Fatalf("create variant dir: %v", err)
	}
	v := &QualityVariant{
		Profile:   QualityProfile{Name: "source"},
		OutputDir: outDir,
		Ready:     make(chan struct{}),
	}
	s := &TranscodeSession{
		ID:              sessionID,
		FilePath:        filepath.Join(base, "movie.mkv"),
		OutputDir:       base,
		Variants:        map[string]*QualityVariant{"source": v},
		LastAccess:      time.Now(),
		Remux:           true,
		AudioTrackIndex: -1,
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

// waitForVariantPlaylist blocks until v's playlist exists, checked the way the
// readiness poller checks it: os.Stat on the same path.
func waitForVariantPlaylist(t *testing.T, s *TranscodeSession, v *QualityVariant) {
	t.Helper()
	s.variantMu.Lock()
	playlist := filepath.Join(v.OutputDir, variantPlaylistName)
	s.variantMu.Unlock()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(playlist); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the stub never wrote %s — the readiness poller has no playlist to find", playlist)
}
