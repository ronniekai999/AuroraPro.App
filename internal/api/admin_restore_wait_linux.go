//go:build linux

package api

import (
	"os/exec"

	"golang.org/x/sys/unix"
)

// wait waits for cmd to exit and reaps it. It first waits without reaping
// (waitid WNOWAIT): until a process is reaped its pid, and so its group id,
// stays its own, so taking it off the list in between leaves no moment in
// which a signal could reach a reused id.
func (r *restoreProcs) wait(cmd *exec.Cmd) error {
	pid := cmd.Process.Pid
	var info unix.Siginfo
	for {
		if err := unix.Waitid(unix.P_PID, pid, &info, unix.WEXITED|unix.WNOWAIT, nil); err != unix.EINTR {
			break
		}
	}
	r.mu.Lock()
	delete(r.live, pid)
	r.mu.Unlock()
	return cmd.Wait()
}
