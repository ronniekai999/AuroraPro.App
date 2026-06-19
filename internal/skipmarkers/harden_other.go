//go:build !linux

package skipmarkers

import "os/exec"

// hardenCmd is a no-op off Linux, where PR_SET_PDEATHSIG is unavailable.
// Aurora's production target is bare-metal Linux; this stub only keeps
// local builds and tests green on other developer platforms.
func hardenCmd(*exec.Cmd) {}
