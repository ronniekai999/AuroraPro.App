package main

import (
	"os"
	"strings"
	"testing"
)

// TestMainWiresTheRestoreJobs pins main's wiring of the database restore
// (internal/api/admin_restore_job.go), which no unit test can drive: the
// registry is built on the root context, so a stop cancels a running restore
// (whose transaction then rolls back to the old data); the router is handed
// that same registry (or its admin handler makes its own, which the drain
// snapshot would not see); and the drain snapshot counts a running restore
// and is published at once when one starts or ends, so the deploy scripts'
// drain waits for it rather than restarting under it. The registry's own
// calls to the publish are tested in internal/api.
func TestMainWiresTheRestoreJobs(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	src := string(raw)
	for _, wiring := range []string{
		"restoreJobs := api.NewRestoreJobs(ctx)",
		"restoreJobs.SetOnChange(transcode.PublishDrainState)",
		"transcode.SetDrainRestoreRunning(restoreJobs.Running)",
		"RestoreJobs: restoreJobs,",
	} {
		if !strings.Contains(src, wiring) {
			t.Errorf("main.go no longer has %q", wiring)
		}
	}
}
