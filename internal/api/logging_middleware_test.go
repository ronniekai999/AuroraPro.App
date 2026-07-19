// 2026-05-27 — Tests for statusCapture's WriteHeader idempotency. A
// double-call used to produce a stdlib "superfluous response.WriteHeader"
// warning (e.g. when a handler wrote an error after chi.Timeout had
// already cancelled the request). The wrapper now silently drops the
// second call to match the underlying ResponseWriter's no-op behavior.
package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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

// deadlineRecorder is a ResponseWriter stub that records SetWriteDeadline
// calls, standing in for net/http's real *response (which supports
// per-request deadlines). http.ResponseController can only reach it through
// statusCapture.Unwrap.
type deadlineRecorder struct {
	http.ResponseWriter
	deadlineCalls int
	lastDeadline  time.Time
}

func (d *deadlineRecorder) SetWriteDeadline(t time.Time) error {
	d.deadlineCalls++
	d.lastDeadline = t
	return nil
}

// TestStatusCaptureUnwrapReachesWriteDeadline pins the 2026-07 streaming
// review fix: RequestLogger wraps EVERY request in statusCapture, and before
// Unwrap existed, http.NewResponseController(w).SetWriteDeadline returned
// ErrNotSupported for all of them — silently re-imposing the global 120s
// WriteTimeout on direct play and subtitle extraction despite four call
// sites written specifically to escape it.
func TestStatusCaptureUnwrapReachesWriteDeadline(t *testing.T) {
	dr := &deadlineRecorder{ResponseWriter: httptest.NewRecorder()}
	sc := &statusCapture{ResponseWriter: dr, status: http.StatusOK}

	want := time.Now().Add(4 * time.Hour)
	if err := http.NewResponseController(sc).SetWriteDeadline(want); err != nil {
		t.Fatalf("SetWriteDeadline through statusCapture: %v (Unwrap missing?)", err)
	}
	if dr.deadlineCalls != 1 {
		t.Fatalf("underlying SetWriteDeadline calls: got %d, want 1", dr.deadlineCalls)
	}
	if !dr.lastDeadline.Equal(want) {
		t.Errorf("deadline: got %v, want %v", dr.lastDeadline, want)
	}
}

// readFromRecorder records whether the sendfile-capable io.ReaderFrom path
// was used by the wrapper.
type readFromRecorder struct {
	http.ResponseWriter
	readFromCalls int
	copied        strings.Builder
}

func (rf *readFromRecorder) ReadFrom(src io.Reader) (int64, error) {
	rf.readFromCalls++
	return io.Copy(&rf.copied, src)
}

func TestStatusCaptureReadFromDelegates(t *testing.T) {
	// When the underlying writer implements io.ReaderFrom (net/http's does —
	// that's the sendfile fast path ServeContent relies on), the wrapper must
	// delegate instead of hiding it behind plain Write calls.
	rf := &readFromRecorder{ResponseWriter: httptest.NewRecorder()}
	sc := &statusCapture{ResponseWriter: rf, status: http.StatusOK}

	// Hide strings.Reader's WriterTo so io.Copy exercises the destination's
	// ReaderFrom — the same shape http.ServeContent produces (it wraps the
	// file in a LimitReader, which has no WriterTo).
	n, err := io.Copy(sc, struct{ io.Reader }{strings.NewReader("payload")})
	if err != nil || n != int64(len("payload")) {
		t.Fatalf("io.Copy through statusCapture: n=%d err=%v", n, err)
	}
	if rf.readFromCalls != 1 {
		t.Fatalf("ReadFrom delegation calls: got %d, want 1", rf.readFromCalls)
	}
	if rf.copied.String() != "payload" {
		t.Errorf("copied body: got %q", rf.copied.String())
	}
	// Implicit-200 bookkeeping must match Write's semantics so a later
	// explicit WriteHeader is still suppressed.
	sc.WriteHeader(http.StatusInternalServerError)
	if sc.status != http.StatusOK {
		t.Errorf("status after ReadFrom + late WriteHeader: got %d, want %d", sc.status, http.StatusOK)
	}
}

func TestStatusCaptureReadFromFallbackWithoutReaderFrom(t *testing.T) {
	// httptest.ResponseRecorder does NOT implement io.ReaderFrom — the
	// wrapper must fall back to a plain copy, not fail.
	rec := httptest.NewRecorder()
	sc := &statusCapture{ResponseWriter: rec, status: http.StatusOK}

	n, err := sc.ReadFrom(strings.NewReader("fallback"))
	if err != nil || n != int64(len("fallback")) {
		t.Fatalf("ReadFrom fallback: n=%d err=%v", n, err)
	}
	if rec.Body.String() != "fallback" {
		t.Errorf("body: got %q, want %q", rec.Body.String(), "fallback")
	}
}
