// 2026-05-27 — Tests for the auto-collected environment context
// rendering in buildIssueBody, plus the field sanitizer that bounds
// each client-supplied value.
package api

import (
	"strings"
	"testing"
)

func TestBuildIssueBodyOmitsEmptyEnvironment(t *testing.T) {
	body := buildIssueBody("hello", "", "", "", 0, "", environmentContext{})
	if strings.Contains(body, "Environment") {
		t.Errorf("expected no Environment section when all env fields empty; got body:\n%s", body)
	}
}

func TestBuildIssueBodyRendersEnvironmentSection(t *testing.T) {
	body := buildIssueBody("hello", "", "", "", 0, "", environmentContext{
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
	body := buildIssueBody("hello", "", "", "", 0, "", environmentContext{
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
	body := buildIssueBody("hello", "", "", "", 0, "", environmentContext{
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

func TestBuildIssueBodyEmbedGate(t *testing.T) {
	// 2026-05-27 — Files at-or-under the Camo limit get the
	// `![attachment](...)` inline embed. Above it: link only + note.
	t.Run("small image gets inline embed", func(t *testing.T) {
		body := buildIssueBody("hi", "", "", "https://x/a.png", 1_000_000, "image/png", environmentContext{})
		if !strings.Contains(body, "![attachment](https://x/a.png)") {
			t.Errorf("expected inline embed for small image; body:\n%s", body)
		}
	})
	t.Run("big image skips embed and adds note", func(t *testing.T) {
		body := buildIssueBody("hi", "", "", "https://x/a.png", 6_500_000, "image/png", environmentContext{})
		if strings.Contains(body, "![attachment]") {
			t.Errorf("expected NO inline embed for big image; body:\n%s", body)
		}
		if !strings.Contains(body, "GitHub's ~5 MB inline-embed limit") {
			t.Errorf("expected explanatory note about embed limit; body:\n%s", body)
		}
	})
	t.Run("video always skips embed", func(t *testing.T) {
		// Covers both .webm (transcode fallback) and .mp4 (transcode
		// success — the new common case post WebM→MP4 conversion).
		for _, mime := range []string{"video/webm", "video/mp4"} {
			body := buildIssueBody("hi", "", "", "https://x/a", 500_000, mime, environmentContext{})
			if strings.Contains(body, "![attachment]") {
				t.Errorf("mime=%s: expected NO inline embed for video; body:\n%s", mime, body)
			}
			if !strings.Contains(body, "click the link above to play") {
				t.Errorf("mime=%s: expected 'click the link above to play' copy; body:\n%s", mime, body)
			}
		}
	})
	t.Run("attachment link always present", func(t *testing.T) {
		// Whether or not we embed, the link itself should always render
		// so triagers can click through.
		for _, size := range []int64{500_000, 10_000_000} {
			body := buildIssueBody("hi", "", "", "https://x/a.png", size, "image/png", environmentContext{})
			if !strings.Contains(body, "**Attachment:** https://x/a.png") {
				t.Errorf("size=%d: expected attachment link; body:\n%s", size, body)
			}
		}
	})
	t.Run("zero-byte image: link only, no embed, no note", func(t *testing.T) {
		// Deep-debug L3 — 0-byte image should not embed (broken Camo
		// render) AND not show the oversize note. Link-only is the
		// right behavior; a 0-byte upload is probably already a
		// usability problem upstream.
		body := buildIssueBody("hi", "", "", "https://x/a.png", 0, "image/png", environmentContext{})
		if strings.Contains(body, "![attachment]") {
			t.Errorf("expected no embed for 0-byte file; body:\n%s", body)
		}
		if strings.Contains(body, "GitHub's ~5 MB") {
			t.Errorf("expected no oversize note for 0-byte file; body:\n%s", body)
		}
		if !strings.Contains(body, "**Attachment:** https://x/a.png") {
			t.Errorf("expected link still rendered; body:\n%s", body)
		}
	})
	t.Run("non-image, non-video MIME: link only", func(t *testing.T) {
		// Deep-debug M6 — `application/pdf` (or anything outside
		// image/* and video/*) shouldn't accidentally fall into the
		// embed branch. Defensive against future safeExtension
		// whitelist expansion.
		body := buildIssueBody("hi", "", "", "https://x/log.pdf", 500_000, "application/pdf", environmentContext{})
		if strings.Contains(body, "![attachment]") {
			t.Errorf("expected no embed for PDF; body:\n%s", body)
		}
		if !strings.Contains(body, "**Attachment:** https://x/log.pdf") {
			t.Errorf("expected link still rendered; body:\n%s", body)
		}
	})
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

// 2026-05-27 — Tests for the WebM remux helpers introduced to fix
// MediaRecorder's missing-Duration metadata bug.

func TestRemuxWebMMissingFfmpeg(t *testing.T) {
	// When ffmpegPath is empty (startup probe found no ffmpeg), the
	// helper must return a clean error without panicking. The
	// caller logs WARN and serves the original file.
	if err := remuxWebM("", "/tmp/whatever.webm"); err == nil {
		t.Error("expected non-nil error when ffmpegPath is empty")
	}
}

func TestTranscodeWebmToMp4MissingFfmpeg(t *testing.T) {
	// 2026-05-27 — Same contract as remuxWebM: clean error
	// (no panic) when ffmpegPath is empty so saveAttachment can
	// fall back to the WebM remux tier without exploding.
	if err := transcodeWebmToMp4("", "/tmp/src.webm", "/tmp/dst.mp4"); err == nil {
		t.Error("expected non-nil error when ffmpegPath is empty")
	}
}

func TestIsRemuxTmp(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		// Real tmp leftovers from the remux path.
		{"abcdef0123456789abcdef0123456789.webm.remux.tmp", true},
		// Other valid attachment with the suffix → also recognized.
		{"abcdef0123456789abcdef0123456789.mp4.remux.tmp", true},
		// Real attachment (no suffix) → NOT a tmp orphan.
		{"abcdef0123456789abcdef0123456789.webm", false},
		// Random file with the suffix but no valid attachment base.
		{"README.remux.tmp", false},
		// Operator's note file unrelated to remux.
		{"hello.txt", false},
		// Suffix-only (degenerate).
		{".remux.tmp", false},
	}
	for _, c := range cases {
		if got := isRemuxTmp(c.name); got != c.want {
			t.Errorf("isRemuxTmp(%q) = %v; want %v", c.name, got, c.want)
		}
	}
}

func TestBoundedBufferCapsWrites(t *testing.T) {
	b := boundedBuffer{cap: 10}
	// Write less than cap.
	n, err := b.Write([]byte("hello"))
	if err != nil || n != 5 {
		t.Fatalf("first Write: n=%d err=%v", n, err)
	}
	if b.String() != "hello" {
		t.Errorf("after first Write: got %q", b.String())
	}
	// Write that overflows the cap. The Writer reports the full
	// length consumed (so callers don't error out), but only the
	// portion that fits is retained.
	n, err = b.Write([]byte("world!!!extra"))
	if err != nil {
		t.Fatalf("second Write returned err=%v", err)
	}
	if n != len("world!!!extra") {
		t.Errorf("second Write should report full byte count consumed; got %d", n)
	}
	if len(b.buf) != b.cap {
		t.Errorf("buffer should be capped at %d, got %d", b.cap, len(b.buf))
	}
}
