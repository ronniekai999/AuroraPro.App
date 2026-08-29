package streaming

import (
	"errors"
	"os/exec"
	"time"
)

// Bounded output capture for the commands this package shells out to.
//
// Attaching a writer to Stdout or Stderr — which Cmd.Output and
// Cmd.CombinedOutput both do, the latter to both streams — changes Wait's
// contract: os/exec copies through a pipe, and Wait then blocks until EVERY
// holder of the child's descriptors closes them, not merely until the process
// exits. A child that leaves a subprocess holding one stalls Wait for as long
// as that subprocess lives, with no bound and past any context deadline — the
// deadline kills the process it started, it cannot close a descriptor someone
// else inherited. Several of these commands run inside NewTranscodeManager, so
// there the stall is a server that never finishes booting.
//
// runBounded caps that wait exactly as runProbeFFmpegDiag caps it for the test
// encodes (hwdecode.go), so the two cannot drift.
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
// Reading it as a failure instead would report every encoder missing, every
// GPU absent, and every finished subtitle extraction broken on a box where
// FFmpeg works — the same mis-verdict runProbeFFmpegDiag documents, arrived at
// from the opposite direction.
func runBounded(cmd *exec.Cmd, capture func() ([]byte, error)) ([]byte, error) {
	// Must be set before Start: Cmd reads it when wiring up the watchdog.
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
