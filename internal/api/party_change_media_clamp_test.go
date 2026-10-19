// Issue #460 — clamps on the client-supplied strings in changeMediaPayload.
//
// The next-episode button made `change-media` reachable from the SPA for the
// first time. Unlike party creation, which derives the title from the DB, this
// path takes media_title / media_poster straight off the wire and writes them
// to parties.media_title / media_poster — VARCHAR(500) since migration 013.
//
// Postgres counts CHARACTERS, not bytes, so the clamp is in runes. A byte
// clamp would be wrong twice over: it would let a 500-rune multi-byte title
// overflow the column (failing the write inside a fire-and-forget goroutine,
// leaving in-memory state diverged from disk until a restart rehydrated the
// stale row), and it could slice a rune in half.
package api

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTruncateRunes_ShortStringUntouched(t *testing.T) {
	const s = "Severance — S02E07"
	if got := truncateRunes(s, partyMediaTextMaxRunes); got != s {
		t.Fatalf("short title was modified: %q", got)
	}
}

func TestTruncateRunes_ClampsToRuneCountNotByteCount(t *testing.T) {
	// Each emoji is 4 bytes, so 600 of them is 2400 bytes — a byte-based
	// clamp at 500 would cut this to 125 runes AND land mid-rune.
	s := strings.Repeat("😀", 600)
	got := truncateRunes(s, partyMediaTextMaxRunes)

	if n := utf8.RuneCountInString(got); n != partyMediaTextMaxRunes {
		t.Errorf("rune count = %d, want %d", n, partyMediaTextMaxRunes)
	}
	if !utf8.ValidString(got) {
		t.Error("truncation split a multi-byte rune")
	}
	if strings.ContainsRune(got, utf8.RuneError) {
		t.Error("truncated value contains a replacement char")
	}
}

func TestTruncateRunes_BoundaryExactAndOneOver(t *testing.T) {
	exact := strings.Repeat("a", partyMediaTextMaxRunes)
	if got := truncateRunes(exact, partyMediaTextMaxRunes); got != exact {
		t.Error("a string exactly at the cap must pass through unchanged")
	}

	over := strings.Repeat("a", partyMediaTextMaxRunes+1)
	if n := utf8.RuneCountInString(truncateRunes(over, partyMediaTextMaxRunes)); n != partyMediaTextMaxRunes {
		t.Errorf("one-over string clamped to %d runes, want %d", n, partyMediaTextMaxRunes)
	}
}

func TestTruncateRunes_EmptyAndNonPositiveMax(t *testing.T) {
	if got := truncateRunes("", partyMediaTextMaxRunes); got != "" {
		t.Errorf("empty string became %q", got)
	}
	// A poster is legitimately empty; the clamp must never invent content.
	if got := truncateRunes("anything", 0); got != "" {
		t.Errorf("max=0 returned %q, want empty", got)
	}
	if got := truncateRunes("anything", -1); got != "" {
		t.Errorf("negative max returned %q, want empty", got)
	}
}

// The cap must not exceed what the column can hold, or the clamp is
// decorative and the DB write still fails.
func TestPartyMediaTextCapFitsColumn(t *testing.T) {
	const columnChars = 500 // migrations/013_requests_and_parties.up.sql
	if partyMediaTextMaxRunes > columnChars {
		t.Fatalf("cap %d exceeds VARCHAR(%d)", partyMediaTextMaxRunes, columnChars)
	}
}

// PostgreSQL text refuses NUL, so one in a title failed every write of it,
// the party's end included. It is removed before the clamp, so a full-length
// title padded with NULs keeps all of its text. This pins the helper only:
// change-media's call to it has no socket-level test.
func TestPartyMediaTextDropsNULBeforeTheClamp(t *testing.T) {
	if got := partyMediaText("Sever\x00ance\x00"); got != "Severance" {
		t.Errorf("got %q, want the NULs removed", got)
	}
	full := strings.Repeat("a", partyMediaTextMaxRunes)
	if got := partyMediaText("\x00\x00" + full); got != full {
		t.Errorf("a full-length title behind two NULs came back as %d runes, want all %d", utf8.RuneCountInString(got), partyMediaTextMaxRunes)
	}
	if n := utf8.RuneCountInString(partyMediaText(full + "b")); n != partyMediaTextMaxRunes {
		t.Errorf("an over-long title came back as %d runes, want %d", n, partyMediaTextMaxRunes)
	}
}
