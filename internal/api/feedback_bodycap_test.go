// 2026-05-29 (med-integration) — tests for the issue-body hard cap.
//
// buildIssueBody must keep the assembled GitHub issue body under
// maxIssueBodyBytes (GitHub rejects bodies > 65536 bytes with a 422).
// The diagnostics section is the only part whose aggregate size is
// effectively unbounded, so it's the part that gets truncated; the
// description, attachment link, environment block and footer are always
// preserved.
package api

import (
	"strings"
	"testing"
)

// hugeConsoleEntries builds n console entries each carrying a ~max-length
// message so the aggregate dwarfs the issue-body cap.
func hugeConsoleEntries(n int) []consoleEntry {
	msg := strings.Repeat("x", maxConsoleMessageChars)
	out := make([]consoleEntry, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, consoleEntry{
			ts:      "2026-05-29T18:00:0" + itoa(i%10) + "Z",
			level:   "error",
			message: msg + itoa(i),
		})
	}
	return out
}

func hugeNetworkEntries(n int) []networkEntry {
	url := "/api/" + strings.Repeat("u", maxNetworkURLChars)
	out := make([]networkEntry, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, networkEntry{
			ts:           "2026-05-29T18:00:00Z",
			method:       "GET",
			url:          url + itoa(i),
			status:       200,
			durationMs:   12,
			responseSize: 4096,
		})
	}
	return out
}

func TestBuildIssueBodyEnforcesHardCap(t *testing.T) {
	// Full-size buffers (the real ring-buffer caps) of max-length entries
	// would produce ~500 KiB of diagnostics if rendered verbatim.
	console := hugeConsoleEntries(maxConsoleEntries)
	network := hugeNetworkEntries(maxNetworkEntries)
	body := buildIssueBody("a real bug description", "Reporter", "ronnie",
		"", 0, "", environmentContext{}, console, network)

	if len(body) > maxIssueBodyBytes {
		t.Fatalf("body length %d exceeds hard cap %d", len(body), maxIssueBodyBytes)
	}
	// And it must stay under GitHub's actual API limit with headroom.
	if len(body) > 65536 {
		t.Fatalf("body length %d exceeds GitHub's 65536-byte limit", len(body))
	}
}

func TestBuildIssueBodyTruncationMarkerAndStructure(t *testing.T) {
	console := hugeConsoleEntries(maxConsoleEntries)
	network := hugeNetworkEntries(maxNetworkEntries)
	body := buildIssueBody("desc", "", "", "", 0, "", environmentContext{}, console, network)

	// A truncation marker must be present (some entries were dropped).
	if !strings.Contains(body, "truncated") {
		t.Errorf("expected a truncation marker in an over-budget body")
	}
	// The <details> blocks must remain balanced — truncation must be
	// whole-entry, never a half-written block that corrupts the markdown.
	if oc, cc := strings.Count(body, "<details>"), strings.Count(body, "</details>"); oc != cc {
		t.Errorf("unbalanced <details> after truncation: open=%d close=%d", oc, cc)
	}
	// The code fence for the console block must be balanced (even count).
	if n := strings.Count(body, "```"); n%2 != 0 {
		t.Errorf("unbalanced ``` code fence after truncation: count=%d", n)
	}
}

func TestBuildIssueBodyPreservesLedeAndFooterWhenTruncating(t *testing.T) {
	console := hugeConsoleEntries(maxConsoleEntries)
	body := buildIssueBody("my unique description text", "Reporter Name", "ronnie",
		"", 0, "", environmentContext{}, console, nil)

	// The user's description (the lede) must survive truncation.
	if !strings.Contains(body, "my unique description text") {
		t.Errorf("description (lede) was dropped during truncation; body head:\n%s", body[:min(400, len(body))])
	}
	// The server-stamped footer must survive — it's how triagers
	// authenticate a real submission, so it must never be the casualty.
	if !strings.Contains(body, "<!-- aurora-footer -->") {
		t.Errorf("footer sentinel was dropped during truncation")
	}
	if !strings.Contains(body, "Submitted via Aurora bug-report") {
		t.Errorf("footer text was dropped during truncation")
	}
	if !strings.Contains(body, "Reporter Name") {
		t.Errorf("submitter name was dropped from the footer during truncation")
	}
}

func TestBuildIssueBodyNoTruncationWhenSmall(t *testing.T) {
	// A small, realistic buffer must NOT be truncated and must NOT carry
	// a truncation marker — the cap only bites pathological/large buffers.
	console := []consoleEntry{
		{ts: "2026-05-29T18:00:00Z", level: "log", message: "app loaded"},
		{ts: "2026-05-29T18:00:01Z", level: "error", message: "boom at line 42"},
	}
	network := []networkEntry{
		{ts: "2026-05-29T18:00:00Z", method: "GET", url: "/api/movies", status: 200, durationMs: 30, responseSize: 2048},
	}
	body := buildIssueBody("desc", "", "", "", 0, "", environmentContext{}, console, network)

	if strings.Contains(body, "truncated") {
		t.Errorf("small buffer should not be truncated; body:\n%s", body)
	}
	if !strings.Contains(body, "boom at line 42") {
		t.Errorf("expected full console content for a small buffer")
	}
	if !strings.Contains(body, "/api/movies") {
		t.Errorf("expected full network content for a small buffer")
	}
	if len(body) > maxIssueBodyBytes {
		t.Errorf("small-buffer body unexpectedly over cap: %d", len(body))
	}
}

// TestBuildIssueBodyHugeDescriptionStillCapsDiagnostics guards the
// case where the non-diagnostic frame is itself large: the diagnostics
// budget can go to (near) zero, and the body must still stay under the
// cap by emitting little or no diagnostics rather than overflowing.
func TestBuildIssueBodyHugeDescriptionStillUnderCap(t *testing.T) {
	// maxFeedbackDescLen-sized description (the real validation ceiling)
	// plus full diagnostic buffers.
	desc := strings.Repeat("d", maxFeedbackDescLen)
	console := hugeConsoleEntries(maxConsoleEntries)
	network := hugeNetworkEntries(maxNetworkEntries)
	body := buildIssueBody(desc, "", "", "", 0, "", environmentContext{}, console, network)

	if len(body) > maxIssueBodyBytes {
		t.Fatalf("body length %d exceeds hard cap %d with a huge description", len(body), maxIssueBodyBytes)
	}
	// Description must still be fully present (it's load-bearing).
	if !strings.Contains(body, desc) {
		t.Errorf("full description should be preserved even when it dominates the body")
	}
	// <details> must stay balanced regardless of how aggressively the
	// diagnostics were trimmed (possibly to nothing).
	if oc, cc := strings.Count(body, "<details>"), strings.Count(body, "</details>"); oc != cc {
		t.Errorf("unbalanced <details>: open=%d close=%d", oc, cc)
	}
}

// TestRenderDiagnosticsBoundedNeverExceedsBudget hammers the budget
// invariant directly across a wide range of small budgets — including
// the worst case where a block opens but the very first entry doesn't
// fit and an immediate truncation marker is required. The returned
// length must NEVER exceed the budget, and any emitted <details> /
// code-fence must stay balanced.
func TestRenderDiagnosticsBoundedNeverExceedsBudget(t *testing.T) {
	console := hugeConsoleEntries(maxConsoleEntries)
	network := hugeNetworkEntries(maxNetworkEntries)
	// Sweep budgets from 0 up through a few KiB, hitting every byte size
	// around the per-block scaffold thresholds.
	for budget := 0; budget <= 4096; budget++ {
		out := renderDiagnosticsBounded(console, network, budget)
		if len(out) > budget {
			t.Fatalf("budget=%d: output len %d exceeds budget", budget, len(out))
		}
		if oc, cc := strings.Count(out, "<details>"), strings.Count(out, "</details>"); oc != cc {
			t.Fatalf("budget=%d: unbalanced <details> open=%d close=%d; out=%q", budget, oc, cc, out)
		}
		if n := strings.Count(out, "```"); n%2 != 0 {
			t.Fatalf("budget=%d: unbalanced code fence count=%d; out=%q", budget, n, out)
		}
	}
}

func TestRenderDiagnosticsBoundedZeroOrNegativeBudget(t *testing.T) {
	console := hugeConsoleEntries(10)
	for _, budget := range []int{0, -1, -1000} {
		if out := renderDiagnosticsBounded(console, nil, budget); out != "" {
			t.Errorf("budget=%d: expected empty output, got %q", budget, out)
		}
	}
}
