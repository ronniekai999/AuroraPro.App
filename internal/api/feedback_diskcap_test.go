// Tests for the aggregate disk-cap on bug-report attachments
// (improvement #3). Covers the env-budget helper, the cache-usage
// accounting, and the janitor's oldest-first budget eviction layered
// on top of the existing TTL sweep.
package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeAttachment creates a whitelisted attachment file of `size` bytes
// with the given mod time under dir, returning its full path. The name
// is a valid 32-hex-char id so isValidAttachmentName accepts it.
func writeAttachment(t *testing.T, dir, name string, size int, mod time.Time) string {
	t.Helper()
	full := filepath.Join(dir, name)
	if err := os.WriteFile(full, make([]byte, size), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	if err := os.Chtimes(full, mod, mod); err != nil {
		t.Fatalf("chtimes %s: %v", name, err)
	}
	return full
}

// 32-hex-char ids (the access-token shape) so the whitelist accepts them.
const (
	idA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"
	idB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png"
	idC = "cccccccccccccccccccccccccccccccc.png"
)

func TestAttachmentMaxTotalBytesDefault(t *testing.T) {
	t.Setenv("BUG_REPORT_ATTACHMENT_MAX_TOTAL_BYTES", "")
	if got := attachmentMaxTotalBytes(); got != defaultAttachmentMaxTotalBytes {
		t.Fatalf("unset: got %d, want default %d", got, defaultAttachmentMaxTotalBytes)
	}
}

func TestAttachmentMaxTotalBytesOverride(t *testing.T) {
	t.Setenv("BUG_REPORT_ATTACHMENT_MAX_TOTAL_BYTES", "12345")
	if got := attachmentMaxTotalBytes(); got != 12345 {
		t.Fatalf("override: got %d, want 12345", got)
	}
}

func TestAttachmentMaxTotalBytesBadValueFallsBack(t *testing.T) {
	for _, bad := range []string{"not-a-number", "0", "-5", "  "} {
		t.Setenv("BUG_REPORT_ATTACHMENT_MAX_TOTAL_BYTES", bad)
		if got := attachmentMaxTotalBytes(); got != defaultAttachmentMaxTotalBytes {
			t.Fatalf("value %q: got %d, want default %d (non-positive/garbage must not disable the cap)",
				bad, got, defaultAttachmentMaxTotalBytes)
		}
	}
}

func TestCacheDirUsageBytes(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	writeAttachment(t, dir, idA, 100, now)
	writeAttachment(t, dir, idB, 250, now)
	// Non-whitelisted operator file must NOT count toward the budget.
	if err := os.WriteFile(filepath.Join(dir, "README.txt"), make([]byte, 9999), 0o644); err != nil {
		t.Fatal(err)
	}
	h := &FeedbackHandler{cacheDir: dir}
	if got := h.cacheDirUsageBytes(); got != 350 {
		t.Fatalf("usage: got %d, want 350 (whitelisted only)", got)
	}
}

func TestCacheDirUsageBytesMissingDir(t *testing.T) {
	h := &FeedbackHandler{cacheDir: filepath.Join(t.TempDir(), "does-not-exist")}
	if got := h.cacheDirUsageBytes(); got != 0 {
		t.Fatalf("missing dir: got %d, want 0", got)
	}
}

// TTL sweep alone keeps recent files and removes old ones; with a large
// budget the budget pass is a no-op.
func TestSweepRemovesOnlyExpiredUnderBudget(t *testing.T) {
	t.Setenv("BUG_REPORT_ATTACHMENT_MAX_TOTAL_BYTES", "1000000000") // 1 GB — far above test data
	dir := t.TempDir()
	now := time.Now()
	writeAttachment(t, dir, idA, 100, now.Add(-48*time.Hour)) // expired
	writeAttachment(t, dir, idB, 100, now)                    // fresh
	h := &FeedbackHandler{cacheDir: dir, effectiveTTL: 24 * time.Hour}
	h.sweepAttachments()
	if _, err := os.Stat(filepath.Join(dir, idA)); !os.IsNotExist(err) {
		t.Fatalf("expired file idA should have been removed; stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, idB)); err != nil {
		t.Fatalf("fresh file idB should remain; stat err=%v", err)
	}
}

// Over budget with all-fresh files: the budget pass must extend the
// sweep and evict OLDEST-first until under budget, even though no file
// is past the TTL.
func TestSweepEvictsOldestFirstWhenOverBudget(t *testing.T) {
	// Budget 150 with three 100B files (300 total): evicting the oldest
	// (→200) is still over, evicting the next (→100) clears it, then the
	// loop stops — so exactly the two oldest go, the newest stays.
	t.Setenv("BUG_REPORT_ATTACHMENT_MAX_TOTAL_BYTES", "150")
	dir := t.TempDir()
	now := time.Now()
	// All within the TTL; distinct mtimes so ordering is deterministic.
	writeAttachment(t, dir, idA, 100, now.Add(-3*time.Hour)) // oldest → evicted first
	writeAttachment(t, dir, idB, 100, now.Add(-2*time.Hour)) // next oldest → evicted second
	writeAttachment(t, dir, idC, 100, now.Add(-1*time.Hour)) // newest → kept
	h := &FeedbackHandler{cacheDir: dir, effectiveTTL: 24 * time.Hour}
	h.sweepAttachments()

	if _, err := os.Stat(filepath.Join(dir, idA)); !os.IsNotExist(err) {
		t.Errorf("oldest idA should have been evicted; stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, idB)); !os.IsNotExist(err) {
		t.Errorf("second-oldest idB should have been evicted; stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, idC)); err != nil {
		t.Errorf("newest idC should be kept (eviction stops as soon as under budget); stat err=%v", err)
	}
	if got := h.cacheDirUsageBytes(); got > 150 {
		t.Errorf("post-sweep usage %d exceeds budget 150", got)
	}
}

// Eviction stops the moment we drop to/under budget — it must not keep
// deleting fresh files past the point of compliance.
func TestSweepEvictsMinimumToReachBudget(t *testing.T) {
	t.Setenv("BUG_REPORT_ATTACHMENT_MAX_TOTAL_BYTES", "250") // 300 total → drop just one 100B file
	dir := t.TempDir()
	now := time.Now()
	writeAttachment(t, dir, idA, 100, now.Add(-3*time.Hour)) // oldest → evicted
	writeAttachment(t, dir, idB, 100, now.Add(-2*time.Hour)) // kept (already under budget)
	writeAttachment(t, dir, idC, 100, now.Add(-1*time.Hour)) // kept
	h := &FeedbackHandler{cacheDir: dir, effectiveTTL: 24 * time.Hour}
	h.sweepAttachments()

	if _, err := os.Stat(filepath.Join(dir, idA)); !os.IsNotExist(err) {
		t.Errorf("oldest idA should have been evicted; stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, idB)); err != nil {
		t.Errorf("idB should be kept once under budget; stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, idC)); err != nil {
		t.Errorf("idC should be kept once under budget; stat err=%v", err)
	}
}

// Budget eviction layers on top of the TTL removal: expired files go via
// the TTL path; if that alone clears the budget, fresh files are spared.
func TestSweepTTLRemovalSatisfiesBudgetWithoutEvictingFresh(t *testing.T) {
	t.Setenv("BUG_REPORT_ATTACHMENT_MAX_TOTAL_BYTES", "150")
	dir := t.TempDir()
	now := time.Now()
	writeAttachment(t, dir, idA, 200, now.Add(-48*time.Hour)) // expired, big → TTL-removed
	writeAttachment(t, dir, idB, 100, now)                    // fresh, 100B → under budget after TTL pass
	h := &FeedbackHandler{cacheDir: dir, effectiveTTL: 24 * time.Hour}
	h.sweepAttachments()
	if _, err := os.Stat(filepath.Join(dir, idA)); !os.IsNotExist(err) {
		t.Errorf("expired idA should be TTL-removed; stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, idB)); err != nil {
		t.Errorf("fresh idB under budget should be kept; stat err=%v", err)
	}
}
