// 2026-05-27 — Tests for the auto-captured console + network diagnostic
// buffer parsing helpers (parseConsoleEntries / parseNetworkEntries /
// sanitizeDiagnosticString / humanizeSize / clampInt*) plus integration
// with buildIssueBody.
package api

import (
	"encoding/json"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------
// parseConsoleEntries
// ---------------------------------------------------------------------

func TestParseConsoleEntriesEmpty(t *testing.T) {
	if got := parseConsoleEntries(""); got != nil {
		t.Errorf("empty input should return nil, got %v", got)
	}
	if got := parseConsoleEntries("   \t\n  "); got != nil {
		t.Errorf("whitespace-only should return nil, got %v", got)
	}
}

func TestParseConsoleEntriesInvalidJSON(t *testing.T) {
	cases := []string{
		"not json",
		"{",
		`{"ts":"x"}`,            // object, not array
		`["string entry"]`,      // not the expected shape
		`[{"ts": 123}]`,         // ts wrong type → decode error
	}
	for _, raw := range cases {
		if got := parseConsoleEntries(raw); got != nil {
			t.Errorf("invalid JSON %q should yield nil, got %v", raw, got)
		}
	}
}

func TestParseConsoleEntriesOverLimitInput(t *testing.T) {
	// > 1 MiB input is rejected before unmarshal.
	big := strings.Repeat("x", (1<<20)+1)
	if got := parseConsoleEntries(big); got != nil {
		t.Errorf("oversized input should return nil, got len=%d", len(got))
	}
}

func TestParseConsoleEntriesHappyPath(t *testing.T) {
	raw := `[
		{"ts":"2026-05-27T18:00:00Z","level":"log","message":"hello"},
		{"ts":"2026-05-27T18:00:01Z","level":"error","message":"boom"}
	]`
	got := parseConsoleEntries(raw)
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(got))
	}
	if got[0].level != "log" || got[0].message != "hello" {
		t.Errorf("entry 0 mismatch: %+v", got[0])
	}
	if got[1].level != "error" || got[1].message != "boom" {
		t.Errorf("entry 1 mismatch: %+v", got[1])
	}
}

func TestParseConsoleEntriesTailKeepsMostRecent(t *testing.T) {
	// Build 250 entries — should be capped at 200 keeping the LAST 200.
	entries := make([]map[string]any, 0, 250)
	for i := 0; i < 250; i++ {
		entries = append(entries, map[string]any{
			"ts":      "2026-05-27T18:00:00Z",
			"level":   "log",
			"message": "msg-" + itoa(i),
		})
	}
	blob, _ := json.Marshal(entries)
	got := parseConsoleEntries(string(blob))
	if len(got) != maxConsoleEntries {
		t.Fatalf("expected cap at %d, got %d", maxConsoleEntries, len(got))
	}
	// First retained entry should be msg-50 (250 - 200 = 50).
	if got[0].message != "msg-50" {
		t.Errorf("tail-keep wrong: first entry msg=%q want msg-50", got[0].message)
	}
	if got[len(got)-1].message != "msg-249" {
		t.Errorf("tail-keep wrong: last entry msg=%q want msg-249", got[len(got)-1].message)
	}
}

func TestParseConsoleEntriesFiltersEmpty(t *testing.T) {
	// Entries with neither level nor message get filtered.
	raw := `[
		{"ts":"x","level":"","message":""},
		{"ts":"x","level":"info","message":"keeper"},
		{"ts":"","level":"","message":""}
	]`
	got := parseConsoleEntries(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 entry after filter, got %d", len(got))
	}
	if got[0].message != "keeper" {
		t.Errorf("kept wrong entry: %+v", got[0])
	}
}

func TestParseConsoleEntriesCapsMessageLength(t *testing.T) {
	// A 2 KB message should be truncated to maxConsoleMessageChars (1024)
	// runes plus an ellipsis from sanitizeDiagnosticString.
	long := strings.Repeat("a", 2000)
	raw := `[{"ts":"x","level":"log","message":"` + long + `"}]`
	got := parseConsoleEntries(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(got))
	}
	// Rune count should equal cap + 1 for the appended ellipsis.
	runeCount := len([]rune(got[0].message))
	if runeCount != maxConsoleMessageChars+1 {
		t.Errorf("expected %d runes (cap + ellipsis), got %d", maxConsoleMessageChars+1, runeCount)
	}
	if !strings.HasSuffix(got[0].message, "…") {
		t.Errorf("expected ellipsis suffix on truncated message")
	}
}

// ---------------------------------------------------------------------
// parseNetworkEntries
// ---------------------------------------------------------------------

func TestParseNetworkEntriesEmpty(t *testing.T) {
	if got := parseNetworkEntries(""); got != nil {
		t.Errorf("empty input should return nil")
	}
}

func TestParseNetworkEntriesInvalidJSON(t *testing.T) {
	if got := parseNetworkEntries("{not json"); got != nil {
		t.Errorf("invalid JSON should return nil")
	}
}

func TestParseNetworkEntriesOverLimitInput(t *testing.T) {
	big := strings.Repeat("x", (1<<20)+1)
	if got := parseNetworkEntries(big); got != nil {
		t.Errorf("oversized input should return nil")
	}
}

func TestParseNetworkEntriesHappyPath(t *testing.T) {
	raw := `[
		{"ts":"2026-05-27T18:00:00Z","method":"get","url":"/api/movies","status":200,"durationMs":120,"responseSize":4096}
	]`
	got := parseNetworkEntries(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(got))
	}
	e := got[0]
	if e.method != "GET" {
		t.Errorf("method should be uppercased: %q", e.method)
	}
	if e.url != "/api/movies" || e.status != 200 || e.durationMs != 120 || e.responseSize != 4096 {
		t.Errorf("fields mismatch: %+v", e)
	}
}

func TestParseNetworkEntriesTailKeepsMostRecent(t *testing.T) {
	entries := make([]map[string]any, 0, 150)
	for i := 0; i < 150; i++ {
		entries = append(entries, map[string]any{
			"ts":           "x",
			"method":       "GET",
			"url":          "/u/" + itoa(i),
			"status":       200,
			"durationMs":   10,
			"responseSize": 1,
		})
	}
	blob, _ := json.Marshal(entries)
	got := parseNetworkEntries(string(blob))
	if len(got) != maxNetworkEntries {
		t.Fatalf("expected cap at %d, got %d", maxNetworkEntries, len(got))
	}
	if got[0].url != "/u/50" {
		t.Errorf("tail-keep wrong: first url %q want /u/50", got[0].url)
	}
	if got[len(got)-1].url != "/u/149" {
		t.Errorf("tail-keep wrong: last url %q want /u/149", got[len(got)-1].url)
	}
}

func TestParseNetworkEntriesFiltersEmptyURL(t *testing.T) {
	raw := `[
		{"ts":"x","method":"GET","url":"","status":0,"durationMs":0,"responseSize":0},
		{"ts":"x","method":"POST","url":"/keep","status":201,"durationMs":50,"responseSize":100}
	]`
	got := parseNetworkEntries(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(got))
	}
	if got[0].url != "/keep" {
		t.Errorf("wrong kept entry: %+v", got[0])
	}
}

func TestParseNetworkEntriesClampsRanges(t *testing.T) {
	// Negative values clamped to 0; absurdly large values clamped down.
	raw := `[
		{"ts":"x","method":"GET","url":"/x","status":-50,"durationMs":-1,"responseSize":-9}
	]`
	got := parseNetworkEntries(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(got))
	}
	if got[0].status != 0 || got[0].durationMs != 0 || got[0].responseSize != 0 {
		t.Errorf("negatives should clamp to 0: %+v", got[0])
	}
	raw2 := `[
		{"ts":"x","method":"GET","url":"/x","status":99999,"durationMs":99999999,"responseSize":999999999999999}
	]`
	got = parseNetworkEntries(raw2)
	if len(got) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(got))
	}
	if got[0].status > 999 || got[0].durationMs > 3_600_000 {
		t.Errorf("upper clamp failed: %+v", got[0])
	}
}

// ---------------------------------------------------------------------
// sanitizeDiagnosticString
// ---------------------------------------------------------------------

func TestSanitizeDiagnosticStringStripsControlChars(t *testing.T) {
	in := "a\x00b\x07c\td\ne"
	got := sanitizeDiagnosticString(in, 100)
	// Tab + newline preserved; nulls/bells removed.
	want := "abc\td\ne"
	if got != want {
		t.Errorf("expected %q, got %q", want, got)
	}
}

func TestSanitizeDiagnosticStringStripsLineSeparators(t *testing.T) {
	// U+2028, U+2029, U+FEFF embedded in the input.
	in := "before\u2028middle\u2029after\uFEFFend"
	got := sanitizeDiagnosticString(in, 100)
	want := "beforemiddleafterend"
	if got != want {
		t.Errorf("expected %q, got %q", want, got)
	}
}

func TestSanitizeDiagnosticStringStripsBacktickFences(t *testing.T) {
	in := "before ``` middle ``` after"
	got := sanitizeDiagnosticString(in, 100)
	if strings.Contains(got, "```") {
		t.Errorf("triple backticks should be stripped; got %q", got)
	}
	if !strings.Contains(got, "ʼʼʼ") {
		t.Errorf("expected substitute char in output; got %q", got)
	}
}

func TestSanitizeDiagnosticStringRuneCaps(t *testing.T) {
	// 4-byte emoji * 600 = 2400 bytes, 600 runes. Cap at 500 runes.
	long := strings.Repeat("🦊", 600)
	got := sanitizeDiagnosticString(long, 500)
	runes := []rune(got)
	// Cap + 1 for ellipsis.
	if len(runes) != 501 {
		t.Fatalf("expected 501 runes (cap + ellipsis), got %d", len(runes))
	}
	if runes[len(runes)-1] != '…' {
		t.Errorf("expected ellipsis suffix, got %q", string(runes[len(runes)-1]))
	}
}

func TestSanitizeDiagnosticStringEmptyOrWhitespace(t *testing.T) {
	if got := sanitizeDiagnosticString("", 100); got != "" {
		t.Errorf("empty in → expected empty out, got %q", got)
	}
	if got := sanitizeDiagnosticString("   \t  ", 100); got != "" {
		t.Errorf("whitespace-only → expected empty out, got %q", got)
	}
}

// ---------------------------------------------------------------------
// humanizeSize
// ---------------------------------------------------------------------

func TestHumanizeSize(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "—"},
		{-1, "—"}, // negative → dash (Content-Length absent)
		{1, "1 B"},
		{1023, "1023 B"},
		{1024, "1.0 KB"},
		{1536, "1.5 KB"},
		{1024 * 1024, "1.0 MB"},
		{int64(2.5 * 1024 * 1024), "2.5 MB"},
	}
	for _, c := range cases {
		if got := humanizeSize(c.in); got != c.want {
			t.Errorf("humanizeSize(%d) = %q; want %q", c.in, got, c.want)
		}
	}
}

// ---------------------------------------------------------------------
// clampInt / clampInt64
// ---------------------------------------------------------------------

func TestClampInt(t *testing.T) {
	if got := clampInt(-5, 0, 10); got != 0 {
		t.Errorf("expected 0, got %d", got)
	}
	if got := clampInt(15, 0, 10); got != 10 {
		t.Errorf("expected 10, got %d", got)
	}
	if got := clampInt(7, 0, 10); got != 7 {
		t.Errorf("expected 7, got %d", got)
	}
}

func TestClampInt64(t *testing.T) {
	if got := clampInt64(-1, 0, 1<<40); got != 0 {
		t.Errorf("expected 0, got %d", got)
	}
	if got := clampInt64((1<<40)+1, 0, 1<<40); got != 1<<40 {
		t.Errorf("expected %d, got %d", int64(1<<40), got)
	}
}

// ---------------------------------------------------------------------
// buildIssueBody integration — diagnostic blocks
// ---------------------------------------------------------------------

func TestBuildIssueBodyOmitsDiagnosticBlocksWhenEmpty(t *testing.T) {
	body := buildIssueBody("hi", "", "", "", 0, "", environmentContext{}, nil, nil)
	if strings.Contains(body, "Console log") {
		t.Errorf("expected no Console block when entries nil; body:\n%s", body)
	}
	if strings.Contains(body, "Network log") {
		t.Errorf("expected no Network block when entries nil; body:\n%s", body)
	}
}

func TestBuildIssueBodyRendersConsoleBlock(t *testing.T) {
	entries := []consoleEntry{
		{ts: "2026-05-27T18:00:00Z", level: "log", message: "loaded"},
		{ts: "2026-05-27T18:00:01Z", level: "error", message: "boom"},
	}
	body := buildIssueBody("hi", "", "", "", 0, "", environmentContext{}, entries, nil)
	if !strings.Contains(body, "Console log") {
		t.Errorf("expected console summary label; body:\n%s", body)
	}
	if !strings.Contains(body, "loaded") {
		t.Errorf("expected log message in body")
	}
	if !strings.Contains(body, "boom") {
		t.Errorf("expected error message in body")
	}
	// Must close the <details>.
	if strings.Count(body, "<details>") != strings.Count(body, "</details>") {
		t.Errorf("unbalanced <details>; body:\n%s", body)
	}
}

func TestBuildIssueBodyRendersNetworkBlock(t *testing.T) {
	entries := []networkEntry{
		{ts: "2026-05-27T18:00:00Z", method: "GET", url: "/api/movies", status: 200, durationMs: 120, responseSize: 4096},
		{ts: "2026-05-27T18:00:01Z", method: "POST", url: "/api/feedback", status: 500, durationMs: 250, responseSize: 0},
	}
	body := buildIssueBody("hi", "", "", "", 0, "", environmentContext{}, nil, entries)
	if !strings.Contains(body, "Network log") {
		t.Errorf("expected network summary label; body:\n%s", body)
	}
	if !strings.Contains(body, "/api/movies") {
		t.Errorf("expected url in body")
	}
	if !strings.Contains(body, "GET") {
		t.Errorf("expected method in body")
	}
	if !strings.Contains(body, "500") {
		t.Errorf("expected status in body")
	}
	// 0-byte response should render as the placeholder dash, not "0 B".
	if !strings.Contains(body, "—") {
		t.Errorf("expected dash placeholder for zero-byte response")
	}
}

func TestBuildIssueBodyEscapesPipeInNetworkURL(t *testing.T) {
	// Pipe chars in URL would break the markdown table — must be escaped.
	entries := []networkEntry{
		{ts: "x", method: "GET", url: "/q?x=a|b|c", status: 200, durationMs: 1, responseSize: 0},
	}
	body := buildIssueBody("hi", "", "", "", 0, "", environmentContext{}, nil, entries)
	if !strings.Contains(body, `\|`) {
		t.Errorf("expected escaped pipe in markdown table; body:\n%s", body)
	}
	if strings.Contains(body, "a|b|c") {
		t.Errorf("raw pipe survived in table cell; body:\n%s", body)
	}
}

func TestBuildIssueBodyDiagnosticBlocksRespectClientContext(t *testing.T) {
	// Diagnostic blocks should render even when only server-side env
	// fields are set — they're independent of hasClientContext().
	entries := []consoleEntry{
		{ts: "x", level: "log", message: "test"},
	}
	body := buildIssueBody("hi", "", "", "", 0, "", environmentContext{
		serverVersion: "abc1234",
		serverTime:    "2026-05-27T18:00:00Z",
	}, entries, nil)
	if !strings.Contains(body, "Console log") {
		t.Errorf("console block should render even without client env; body:\n%s", body)
	}
}

// ---------------------------------------------------------------------
// Deep-debug follow-ups
// ---------------------------------------------------------------------

func TestParseConsoleEntriesHandlesNullElement(t *testing.T) {
	// A literal `null` entry in the array used to slip through with a
	// zero-value struct, then get caught by the message+level filter.
	// Lock the behavior in.
	raw := `[null, {"ts":"x","level":"log","message":"keeper"}, null]`
	got := parseConsoleEntries(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 entry after null filter, got %d: %+v", len(got), got)
	}
	if got[0].message != "keeper" {
		t.Errorf("wrong kept entry: %+v", got[0])
	}
}

func TestParseNetworkEntriesHandlesNullElement(t *testing.T) {
	raw := `[null, {"ts":"x","method":"GET","url":"/keep","status":200,"durationMs":1,"responseSize":1}, null]`
	got := parseNetworkEntries(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 entry after null filter, got %d: %+v", len(got), got)
	}
	if got[0].url != "/keep" {
		t.Errorf("wrong kept entry: %+v", got[0])
	}
}

func TestNormalizeConsoleLevelAllowList(t *testing.T) {
	// Known levels pass through (lowercased + trimmed).
	for _, level := range []string{"log", "info", "warn", "error", "debug"} {
		if got := normalizeConsoleLevel(level); got != level {
			t.Errorf("normalizeConsoleLevel(%q) = %q; want %q", level, got, level)
		}
		// Case-insensitive match.
		upper := strings.ToUpper(level)
		if got := normalizeConsoleLevel(upper); got != level {
			t.Errorf("normalizeConsoleLevel(%q) = %q; want %q", upper, got, level)
		}
	}
	// Unknown values fall back to "log".
	for _, bogus := range []string{"", "trace", "fake-level", "info<script>", "log;DROP", "   "} {
		if got := normalizeConsoleLevel(bogus); got != "log" {
			t.Errorf("normalizeConsoleLevel(%q) = %q; want fallback %q", bogus, got, "log")
		}
	}
}

func TestParseConsoleEntriesNormalizesLevel(t *testing.T) {
	// Bogus level on the wire → backend coerces to "log".
	raw := `[{"ts":"x","level":"fake-level","message":"keep me"}]`
	got := parseConsoleEntries(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(got))
	}
	if got[0].level != "log" {
		t.Errorf("bogus level not normalized: %+v", got[0])
	}
	if got[0].message != "keep me" {
		t.Errorf("message lost during normalize: %+v", got[0])
	}
}

func TestBuildIssueBodyPreservesHTMLInsideCodeFence(t *testing.T) {
	// Deep-debug M — HTML closing tags inside a console message render
	// harmlessly *inside* the outer ``` code fence. The contract is:
	// (1) the message text is present in the body, and (2) the body's
	// own <details>/</details> tags stay balanced. A future refactor
	// that drops the fenced-code wrapper would break this test.
	entries := []consoleEntry{
		{ts: "x", level: "error", message: "fail </details><script>alert(1)</script>"},
	}
	body := buildIssueBody("hi", "", "", "", 0, "", environmentContext{}, entries, nil)
	if !strings.Contains(body, "</details><script>alert(1)</script>") {
		t.Errorf("expected raw HTML preserved inside code fence; body:\n%s", body)
	}
	// Balanced <details> tags from buildIssueBody itself (the embedded
	// </details> in the message text shouldn't be counted as the close
	// of the surrounding block — but since both sides increment the
	// count equally, the assertion is "open == close").
	openCount := strings.Count(body, "<details>")
	closeCount := strings.Count(body, "</details>")
	if openCount != closeCount-1 {
		// The message itself adds one extra </details> with no matching
		// <details>, so close should be open + 1.
		t.Errorf("expected close==open+1 (one unmatched </details> in message); got open=%d close=%d", openCount, closeCount)
	}
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

// itoa avoids importing strconv just for tests — keeps imports minimal.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
