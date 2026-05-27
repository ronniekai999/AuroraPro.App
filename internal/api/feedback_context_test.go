// 2026-05-27 — Tests for the auto-collected environment context
// rendering in buildIssueBody, plus the field sanitizer that bounds
// each client-supplied value.
package api

import (
	"strings"
	"testing"
)

func TestBuildIssueBodyOmitsEmptyEnvironment(t *testing.T) {
	body := buildIssueBody("hello", "", "", "", environmentContext{})
	if strings.Contains(body, "Environment") {
		t.Errorf("expected no Environment section when all env fields empty; got body:\n%s", body)
	}
}

func TestBuildIssueBodyRendersEnvironmentSection(t *testing.T) {
	body := buildIssueBody("hello", "", "", "", environmentContext{
		url:           "/movies?sort=year",
		viewport:      "1920x1080",
		userAgent:     "Mozilla/5.0",
		serverVersion: "abc1234",
		serverTime:    "2026-05-27T18:00:00Z",
	})
	if !strings.Contains(body, "<details>") {
		t.Error("expected collapsed <details> block in body")
	}
	if !strings.Contains(body, "Environment (auto-collected)") {
		t.Error("expected Environment summary label")
	}
	if !strings.Contains(body, "/movies?sort=year") {
		t.Error("expected URL field in body")
	}
	if !strings.Contains(body, "abc1234") {
		t.Error("expected server version in body")
	}
	if !strings.Contains(body, "</details>") {
		t.Error("expected closing </details> tag")
	}
}

func TestBuildIssueBodyEscapesBackticksInEnv(t *testing.T) {
	// Deep-debug M4 — assert the value is wrapped in a dynamic-fence
	// code span that's wider than any backtick run inside the value.
	// Previous test only checked the value-without-escape wasn't
	// present, which would pass even for the broken `Evil\`tick\`UA`
	// output that CommonMark renders incorrectly.
	body := buildIssueBody("hello", "", "", "", environmentContext{
		url:       "/x", // trigger the <details> block via client context
		userAgent: "Evil`backtick`UA",
	})
	// Single backtick in the value, so renderCodeSpan should pick
	// a double-backtick fence.
	want := "``Evil`backtick`UA``"
	if !strings.Contains(body, want) {
		t.Errorf("expected dynamic-fence wrap %q in body:\n%s", want, body)
	}
}

func TestRenderCodeSpanPicksWiderFence(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"plain", "`plain`"},
		{"one`tick", "``one`tick``"},
		{"two``ticks", "```two``ticks```"},
		// Leading backtick → space padding (CommonMark trims one
		// leading/trailing space inside code spans).
		{"`leading", "`` `leading ``"},
		// Trailing backtick → space padding.
		{"trailing`", "`` trailing` ``"},
	}
	for _, c := range cases {
		if got := renderCodeSpan(c.in); got != c.want {
			t.Errorf("renderCodeSpan(%q) = %q; want %q", c.in, got, c.want)
		}
	}
}

func TestSanitizeContextFieldTrimsAndCaps(t *testing.T) {
	// Whitespace trimmed.
	if got := sanitizeContextField("  hello  "); got != "hello" {
		t.Errorf("expected trim, got %q", got)
	}
	// Long input capped to 500 chars.
	long := strings.Repeat("x", 1000)
	if got := sanitizeContextField(long); len(got) != 500 {
		t.Errorf("expected 500-char cap, got %d", len(got))
	}
}

func TestSanitizeContextFieldStripsControlChars(t *testing.T) {
	// Newlines + bell + null embedded in a value would break the
	// single-line markdown render. Strip all control chars except tab.
	input := "first\x00line\nsecond\x07\tthird"
	got := sanitizeContextField(input)
	for _, r := range got {
		if r < 0x20 && r != '\t' {
			t.Errorf("control char survived sanitization in %q", got)
		}
	}
	// Tab preserved.
	if !strings.Contains(got, "\t") {
		t.Errorf("tab should be preserved, got %q", got)
	}
}

func TestEnvironmentContextHasClientContext(t *testing.T) {
	if (environmentContext{}).hasClientContext() {
		t.Error("empty context should report no client fields")
	}
	if !(environmentContext{url: "/x"}).hasClientContext() {
		t.Error("url-only context should report client fields present")
	}
	// Deep-debug H2 — server-only fields do NOT trigger hasClientContext.
	// The <details> block needs at least one client-supplied value
	// to render; server-stamped fields are additive.
	if (environmentContext{serverVersion: "x", serverTime: "y"}).hasClientContext() {
		t.Error("server-only fields should NOT trigger hasClientContext (deep-debug H2)")
	}
}

func TestBuildIssueBodyOmitsBlockWhenOnlyServerFieldsSet(t *testing.T) {
	// Deep-debug H2 — server always sets serverTime, but a Submit
	// with no client_* fields should NOT render the <details> block
	// (would be a near-empty Environment section, contradicting the
	// docstring promise).
	body := buildIssueBody("hello", "", "", "", environmentContext{
		serverVersion: "abc1234",
		serverTime:    "2026-05-27T18:00:00Z",
	})
	if strings.Contains(body, "<details>") {
		t.Errorf("expected no <details> block when only server fields set; body:\n%s", body)
	}
}

func TestSanitizeContextFieldUTF8Safe(t *testing.T) {
	// Deep-debug H3 — rune-bounded cap, not byte-bounded. Build a
	// 501-rune string of 4-byte emoji (2004 bytes total). After
	// sanitization the result must be 500 runes (2000 bytes) and
	// valid UTF-8.
	emoji := "🦊"
	long := strings.Repeat(emoji, 501)
	got := sanitizeContextField(long)
	gotRunes := []rune(got)
	if len(gotRunes) != 500 {
		t.Errorf("rune count: got %d, want 500", len(gotRunes))
	}
	for _, r := range gotRunes {
		if r != '🦊' {
			t.Errorf("emoji corruption at rune %q; got %U", r, r)
			break
		}
	}
}

func TestSanitizeContextFieldStripsLineSeparators(t *testing.T) {
	// Deep-debug H3 — Unicode line separators (U+2028, U+2029) are
	// > 0x20 but render as line breaks. Strip them.
	got := sanitizeContextField("before middle after")
	if strings.ContainsRune(got, ' ') || strings.ContainsRune(got, ' ') {
		t.Errorf("line separators should be stripped; got %q", got)
	}
	if got != "beforemiddleafter" {
		t.Errorf("expected joined content; got %q", got)
	}
}
