// 2026-05-27 — Tests for statusCapture's WriteHeader idempotency. A
// double-call used to produce a stdlib "superfluous response.WriteHeader"
// warning (e.g. when a handler wrote an error after chi.Timeout had
// already cancelled the request). The wrapper now silently drops the
// second call to match the underlying ResponseWriter's no-op behavior.
package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStatusCaptureFirstWriteHeaderWins(t *testing.T) {
	rec := httptest.NewRecorder()
	sc := &statusCapture{ResponseWriter: rec, status: http.StatusOK}

	sc.WriteHeader(http.StatusBadRequest)
	sc.WriteHeader(http.StatusInternalServerError) // should be dropped

	// Capture should record the first status (what the client saw).
	if sc.status != http.StatusBadRequest {
		t.Errorf("status: got %d, want %d (first call wins)", sc.status, http.StatusBadRequest)
	}
	// Underlying recorder should only have seen the first WriteHeader
	// (httptest.ResponseRecorder always reports the last code written;
	// since the second call should be a no-op at our level, the
	// recorder must still show the first code).
	if rec.Code != http.StatusBadRequest {
		t.Errorf("recorder code: got %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestStatusCaptureWriteImpliesWriteHeader(t *testing.T) {
	// Calling Write without an explicit WriteHeader should flip
	// wroteHeader (matches net/http's implicit-200 semantics) so a
	// subsequent explicit WriteHeader call is also a no-op and doesn't
	// trigger the stdlib superfluous-header warning.
	rec := httptest.NewRecorder()
	sc := &statusCapture{ResponseWriter: rec, status: http.StatusOK}

	if _, err := sc.Write([]byte("hello")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	// Now an explicit WriteHeader should be dropped.
	sc.WriteHeader(http.StatusInternalServerError)

	// sc.status stays at the constructor default since the implicit
	// path doesn't set a status — matches net/http behavior.
	if sc.status != http.StatusOK {
		t.Errorf("status: got %d, want %d", sc.status, http.StatusOK)
	}
	if rec.Body.String() != "hello" {
		t.Errorf("body: got %q, want %q", rec.Body.String(), "hello")
	}
}

func TestStatusCaptureSingleWriteHeaderStillWorks(t *testing.T) {
	// Sanity check: the common path (one WriteHeader call) still flows
	// through to the underlying writer.
	rec := httptest.NewRecorder()
	sc := &statusCapture{ResponseWriter: rec, status: http.StatusOK}

	sc.WriteHeader(http.StatusCreated)
	if sc.status != http.StatusCreated {
		t.Errorf("status: got %d, want %d", sc.status, http.StatusCreated)
	}
	if rec.Code != http.StatusCreated {
		t.Errorf("recorder code: got %d, want %d", rec.Code, http.StatusCreated)
	}
}
