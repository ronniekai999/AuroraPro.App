package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestShutdownWaitsForARestoreBeforeItCancelsTheServer pins main's shutdown
// order, which no unit test can drive: a database restore runs as a job on
// the root context (internal/api/admin_restore_job.go), so cancelling that
// context kills it, and one killed after its wipe leaves the database empty.
// main must call restoreJobs.Drain after the signal and before it cancels the
// root context; and it must hand the same registry to the router (or the
// router's admin handler makes its own, which nothing waits for) and to the
// drain snapshot. RestoreJobs.Drain's own waiting is tested in internal/api.
func TestShutdownWaitsForARestoreBeforeItCancelsTheServer(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	src := string(raw)
	signal := strings.Index(src, "case <-quit:")
	drain := strings.Index(src, "restoreJobs.Drain(restoreShutdownGrace)")
	stopped := strings.Index(src, `slog.Info("server stopped")`)
	if signal < 0 || drain < 0 || stopped < 0 {
		t.Fatalf("main.go no longer has the shutdown landmarks this test reads (signal %d, drain %d, server stopped %d)", signal, drain, stopped)
	}
	// The root context's cancel after the HTTP server has stopped.
	cancelAt := regexp.MustCompile(`\n\tcancel\(\)\n`).FindStringIndex(src[stopped:])
	if cancelAt == nil {
		t.Fatal("main.go no longer cancels the root context after the server stops")
	}
	if !(signal < drain && drain < stopped+cancelAt[0]) {
		t.Errorf("restoreJobs.Drain must run after the shutdown signal and before the root context is cancelled (signal %d, drain %d, cancel %d)", signal, drain, stopped+cancelAt[0])
	}
	for _, wiring := range []string{
		"restoreJobs := api.NewRestoreJobs(ctx)",
		"RestoreJobs: restoreJobs,",
		"transcode.SetDrainRestoreRunning(restoreJobs.Running)",
	} {
		if !strings.Contains(src, wiring) {
			t.Errorf("main.go no longer has %q", wiring)
		}
	}
}

// TestTheRestoreGraceFitsInsideTheUnitsStopTimeout: the wait plus the rest of
// the shutdown (the HTTP server's 10 s, the workers' 5 s) must end before
// systemd's SIGKILL, and the unit must send its SIGTERM to the server alone
// so the restore's psql and pg_restore are not signalled with it.
func TestTheRestoreGraceFitsInsideTheUnitsStopTimeout(t *testing.T) {
	raw, err := os.ReadFile("../../scripts/aurora.service")
	if err != nil {
		t.Fatalf("read the unit: %v", err)
	}
	unit := string(raw)
	if !regexp.MustCompile(`(?m)^KillMode=mixed$`).MatchString(unit) {
		t.Error("scripts/aurora.service must set KillMode=mixed: the default sends the stop's SIGTERM to pg_restore too")
	}
	m := regexp.MustCompile(`(?m)^TimeoutStopSec=(\d+)min$`).FindStringSubmatch(unit)
	if m == nil {
		t.Fatal("scripts/aurora.service must set TimeoutStopSec in minutes")
	}
	stop, _ := time.ParseDuration(m[1] + "m")
	if restoreShutdownGrace+30*time.Second > stop {
		t.Errorf("restoreShutdownGrace %v leaves under 30 s of the unit's TimeoutStopSec %v for the rest of the shutdown", restoreShutdownGrace, stop)
	}
}
