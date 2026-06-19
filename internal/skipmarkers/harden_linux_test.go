//go:build linux

package skipmarkers

import (
	"os/exec"
	"syscall"
	"testing"
)

// Analyzer children must be set to die with the parent so an OOM-kill or
// crash of the server can't leave orphaned ffmpeg processes that pin RAM
// and feed a restart death spiral.
func TestHardenCmdSetsParentDeathSignal(t *testing.T) {
	cmd := exec.Command("ffmpeg")
	hardenCmd(cmd)
	if cmd.SysProcAttr == nil {
		t.Fatal("hardenCmd must set SysProcAttr")
	}
	if cmd.SysProcAttr.Pdeathsig != syscall.SIGKILL {
		t.Fatalf("Pdeathsig = %v, want SIGKILL — children must die with the parent", cmd.SysProcAttr.Pdeathsig)
	}
	if !cmd.SysProcAttr.Setpgid {
		t.Fatal("Setpgid must be true so the child runs in its own process group")
	}
}
