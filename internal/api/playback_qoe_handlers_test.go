package api

// Trust-boundary coverage for the playback QoE ingest endpoints (August 2026
// review, item #1).
//
// Everything these handlers receive comes from a browser, and they sit on the
// hot path of every playback anyone starts. Two properties matter more than the
// happy path, and neither is visible from the query layer's own tests:
//
//   - unauthenticated callers are refused outright;
//   - authenticated callers are NEVER handed an error to react to, whatever
//     they send. A 4xx here would surface as a failed request in the middle of
//     someone's movie, and the finish call arrives via sendBeacon during page
//     unload where nothing can act on a response anyway.
//
// The database-touching behavior (two-phase write, per-profile authorization,
// enum normalization, retention) is covered in
// internal/db/queries_playback_qoe_test.go against a real Postgres.

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
)

// qoeRequest builds a POST carrying the given body, optionally authenticated.
func qoeRequest(t *testing.T, path, body string, authed bool) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	if authed {
		ctx := context.WithValue(req.Context(), auth.ClaimsContextKey, &auth.JWTClaims{UserID: 42})
		req = req.WithContext(ctx)
	}
	return req
}

func TestPlaybackQoE_RequiresAuthentication(t *testing.T) {
	h := NewPlaybackQoEHandler(nil)

	for _, tc := range []struct {
		name    string
		path    string
		handler http.HandlerFunc
	}{
		{"start", "/api/stream/qoe/start", h.RecordStart},
		{"finish", "/api/stream/qoe/finish", h.RecordFinish},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tc.handler(rec, qoeRequest(t, tc.path, `{"session_token":"`+strings.Repeat("a", 32)+`"}`, false))
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("unauthenticated request = %d, want 401", rec.Code)
			}
		})
	}
}

// TestPlaybackQoE_MalformedInputIsNeverAnError is the load-bearing one. Each of
// these bodies is rejected before any query runs, so a nil Queries is safe —
// and if a future change moved the validation AFTER the database call, this
// test would panic rather than quietly start issuing 4xx to a mid-playback
// client.
func TestPlaybackQoE_MalformedInputIsNeverAnError(t *testing.T) {
	h := NewPlaybackQoEHandler(nil)

	bodies := map[string]string{
		"not json":           `{{{`,
		"empty object":       `{}`,
		"missing token":      `{"decision":"transcode"}`,
		"token too short":    `{"session_token":"abc"}`,
		"token uppercase":    `{"session_token":"` + strings.Repeat("A", 32) + `"}`,
		"token non hex":      `{"session_token":"` + strings.Repeat("z", 32) + `"}`,
		"token sql-ish":      `{"session_token":"'; DROP TABLE playback_qoe_sessions--"}`,
		"wrong field types":  `{"session_token":12345,"decision":true}`,
		"deeply nested junk": `{"session_token":{"a":{"b":{"c":[1,2,3]}}}}`,
	}

	for name, body := range bodies {
		for _, ep := range []struct {
			label   string
			handler http.HandlerFunc
			path    string
		}{
			{"start", h.RecordStart, "/api/stream/qoe/start"},
			{"finish", h.RecordFinish, "/api/stream/qoe/finish"},
		} {
			t.Run(name+"/"+ep.label, func(t *testing.T) {
				rec := httptest.NewRecorder()
				ep.handler(rec, qoeRequest(t, ep.path, body, true))
				if rec.Code != http.StatusNoContent {
					t.Errorf("body %q returned %d, want 204 — telemetry must never hand a "+
						"playing client an error to react to", body, rec.Code)
				}
			})
		}
	}
}

// TestPlaybackQoE_OversizedBodyIsRejectedWithoutError checks the MaxBytesReader
// cap. The payloads are a few hundred bytes; a megabyte of JSON is either a bug
// or an attempt to use the analytics endpoint as a memory sink, and neither
// deserves a parsed body — nor an error the client can retry against.
func TestPlaybackQoE_OversizedBodyIsRejectedWithoutError(t *testing.T) {
	h := NewPlaybackQoEHandler(nil)
	huge := `{"session_token":"` + strings.Repeat("a", 32) + `","pad":"` + strings.Repeat("x", 1<<20) + `"}`

	rec := httptest.NewRecorder()
	h.RecordStart(rec, qoeRequest(t, "/api/stream/qoe/start", huge, true))
	if rec.Code != http.StatusNoContent {
		t.Errorf("oversized body returned %d, want 204", rec.Code)
	}
}

// TestPlaybackQoE_SummaryRejectsInvalidWindow covers the one endpoint that IS
// allowed to answer with an error, because it is an admin read rather than a
// hot-path write.
func TestPlaybackQoE_SummaryRejectsInvalidWindow(t *testing.T) {
	h := NewPlaybackQoEHandler(nil)
	for _, bad := range []string{"0", "-5", "abc"} {
		rec := httptest.NewRecorder()
		h.Summary(rec, httptest.NewRequest(http.MethodGet, "/api/admin/playback-qoe?hours="+bad, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("hours=%q returned %d, want 400", bad, rec.Code)
		}
	}
}
