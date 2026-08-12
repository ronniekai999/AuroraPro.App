package api

// Handler-level guards added while resolving review findings. These shipped
// untested in one commit; the same rationale that demanded player-side coverage
// applies here.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/db"
)

// TestPlaybackQoE_SummaryRejectsAnOversizedWindow pins the change from silently
// clamping UP to rejecting. Widening an out-of-range request handed a typo the
// most expensive query the endpoint can run — a full table scan, three times
// inside one transaction — while reporting a partial period as complete.
func TestPlaybackQoE_SummaryRejectsAnOversizedWindow(t *testing.T) {
	h := NewPlaybackQoEHandler(nil, nil)
	maxHours := int(db.PlaybackQoERetention.Hours())

	for _, hours := range []string{"99999", "100000000"} {
		rec := httptest.NewRecorder()
		h.Summary(rec, httptest.NewRequest(http.MethodGet, "/api/admin/playback-qoe?hours="+hours, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("hours=%s returned %d, want 400 — an oversized window must not be "+
				"silently widened into the most expensive query available", hours, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "retention") {
			t.Errorf("hours=%s: the error should say why (%d is the retention bound); got %s",
				hours, maxHours, rec.Body.String())
		}
	}
}

// TestPlaybackQoE_RestampRequiresAuthAndTolerates Junk mirrors the ingest
// endpoints: authentication is enforced, and nothing else is ever an error the
// player has to handle.
func TestPlaybackQoE_RestampRequiresAuthAndToleratesJunk(t *testing.T) {
	h := NewPlaybackQoEHandler(nil, nil)
	token := strings.Repeat("a", 32)

	rec := httptest.NewRecorder()
	h.Restamp(rec, qoeRequest(t, "/api/stream/qoe/restamp",
		`{"session_token":"`+token+`","session_id":"abc"}`, false))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated restamp = %d, want 401", rec.Code)
	}

	// Authenticated but unusable payloads are accepted silently — they are
	// rejected before any query runs, so a nil Queries is safe here and a
	// future change that moved validation after the DB call would panic
	// rather than quietly start 4xx-ing a playing client.
	for name, body := range map[string]string{
		"not json":        `{{{`,
		"missing token":   `{"session_id":"abc"}`,
		"bad token":       `{"session_token":"nope","session_id":"abc"}`,
		"missing session": `{"session_token":"` + token + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.Restamp(rec, qoeRequest(t, "/api/stream/qoe/restamp", body, true))
			if rec.Code != http.StatusNoContent {
				t.Errorf("body %q returned %d, want 204", body, rec.Code)
			}
		})
	}
}
