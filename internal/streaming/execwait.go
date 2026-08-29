package streaming

import (
	"errors"
	"os/exec"
	"time"
)

// Bounded output capture for the commands this package shells out to.
//
// Attaching a writer that is not an *os.File to Stdout or Stderr changes Wait's
// contract: os/exec cannot hand the child a descriptor it already has, so it
// copies through a pipe, and Wait then blocks until EVERY holder of that pipe
// closes it — not merely until the process exits. (Hand it an *os.File and
// there is no pipe and no wait; a buffer is what creates one.) Both capture
// methods leave BOTH streams on buffers, so neither is exposed on stdout alone:
// CombinedOutput by definition, Output because it installs its own stderr saver
// whenever Stderr is nil, which is every call site here. (CombinedOutput points
// both at one buffer, and os/exec then reuses a single pipe for the pair; one
// holder is all it takes either way.)
//
// So a child that leaves a subprocess holding one stalls Wait for as long as
// that subprocess lives, with no bound and past any context deadline — the
// deadline kills the process it started, it cannot close a descriptor someone
// else inherited. Several of these commands run inside NewTranscodeManager, so
// there the stall is a server that never finishes booting.
//
// runBounded caps that wait with the same constant runProbeFFmpegDiag uses for
// the test encodes (hwdecode.go). Note what is and is not shared: the bound is,
// the READING below is not — hwdecode.go and startVariantImpl each spell out
// their own, because each needs the process's output or error differently.
// Three copies of one decision is three places it can drift, so each carries a
// test that fails if it does.
//
// ErrWaitDelay — the failure mode the cap introduces — is deliberately NOT
// treated as a failed command, for two reasons that hold at every call site:
//
//   - It means the process exited SUCCESSFULLY. Wait reports it only in place
//     of a nil error: a non-zero exit is an ExitError, which takes precedence,
//     and a context kill leaves the process unsuccessful, so that outranks it
//     too. All ErrWaitDelay adds to "exited 0" is that a descriptor outlived
//     the process.
//   - The output still stands. Output/CombinedOutput return the bytes
//     collected before the pipes were closed, and Wait awaits the copying
//     goroutines before returning either way, so the buffer is complete as of
//     the close and safe to read without a race.
//
// Reading it as a failure instead would take a command that WORKED and hand
// every caller its error path: a GPU that is present reported absent, readrate
// pacing disabled on an FFmpeg 7 build, a file's subtitle tracks reported as
// none, and — worst, because it destroys work rather than just misjudging it —
// a completed .vtt deleted and the request that asked for it failed. Note that
// ffmpegHasEncoder's error path answers TRUE, so there the same mistake runs
// the other way: an encoder the build does NOT have would be reported present.
// The direction differs; that it is a mis-verdict does not.
//
// The residual risk is the mirror image, and it is much smaller. WaitDelay
// closes the pipe, so bytes still in flight at that instant are lost and a
// caller could scan a truncated capture — "complete as of the close" is the
// honest guarantee, not "complete". It takes a copying goroutine starved for
// the whole delay AFTER the process already exited, and every caller lands
// somewhere its normal failure already lands: a device or encoder read as
// absent, pacing off, no subtitle tracks. The one signature that differs is
// ProbeSubtitles, where a half-read JSON document returns a parse error rather
// than its usual (nil, nil) — every caller of it discards the error, so what
// reaches a viewer is the same "no subtitles", but the shape is not identical.
func runBounded(cmd *exec.Cmd, capture func() ([]byte, error)) ([]byte, error) {
	// Must be set before Start. Not for the wiring — every caller here passes a
	// context, so Cmd.Cancel already starts the watchdog either way — but
	// because that watchdog goroutine READS WaitDelay, so writing it afterwards
	// is a data race.
	cmd.WaitDelay = execWaitDelay
	out, err := capture()
	if errors.Is(err, exec.ErrWaitDelay) {
		return out, nil
	}
	return out, err
}

// boundedOutput is cmd.Output with the wait bounded (see runBounded).
func boundedOutput(cmd *exec.Cmd) ([]byte, error) {
	return runBounded(cmd, cmd.Output)
}

// boundedCombinedOutput is cmd.CombinedOutput with the wait bounded (see
// runBounded). Prefer it over boundedOutput where the command's useful output
// may land on either stream.
func boundedCombinedOutput(cmd *exec.Cmd) ([]byte, error) {
	return runBounded(cmd, cmd.CombinedOutput)
}

// execWaitDelay bounds how long Wait keeps draining a command's output pipes
// after the process is done or its context has fired. Generous for pipes that
// should already be closed, short enough that startup cannot stall on them.
const execWaitDelay = 2 * time.Second
