//go:build linux

package skipmarkers

import (
	"os/exec"
	"syscall"
)

// hardenCmd makes an analyzer FFmpeg child die with its parent. Without
// it, an OOM-kill or hard crash of the Aurora process leaves ffmpeg
// orphaned (reparented to init) and still pinning its RAM; on restart
// the boot sweep replays the cursor from zero, re-attacks the same not-
// yet-ledgered file, and spawns another. Orphans then accumulate across
// restarts into a memory death spiral. PR_SET_PDEATHSIG (SIGKILL) has
// the kernel reap the child the instant its parent goes away; the
// dedicated process group keeps the child cleanly separable from the
// server's own group.
func hardenCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:   true,
		Pdeathsig: syscall.SIGKILL,
	}
}
