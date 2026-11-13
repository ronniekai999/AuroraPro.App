//go:build !linux

package api

import "os/exec"

// wait waits for cmd to exit and reaps it, then takes it off the list. The
// server runs on Linux, where admin_restore_wait_linux.go takes it off before
// reaping; this keeps the code building on the systems people develop on.
// Here the gap that guard closes stays open: between the reaping and the
// removal a stop could signal a process group whose id the kernel has just
// handed to another process (very unlikely).
func (r *restoreProcs) wait(cmd *exec.Cmd) error {
	err := cmd.Wait()
	r.mu.Lock()
	delete(r.live, cmd.Process.Pid)
	r.mu.Unlock()
	return err
}
