// 2026-05-27 — Tests for the timeout classification helpers introduced
// by the PR #126 follow-up. Full Submit-handler integration coverage
// (multipart upload + auth + httptest GitHub stub) is a separate
// follow-up; these tests lock in the small-surface behavior of
// isNetTimeout + outboundCtx so a future error-classification regression
// is caught early.
package api

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"testing"
	"time"
)

// Compile-time guard: fakeNetErr below must satisfy net.Error.
var _ = (func() bool {
	type netError interface {
		error
		Timeout() bool
		Temporary() bool
	}
	var _ netError = (*fakeNetErr)(nil)
	return true
}())

func TestIsNetTimeoutBoundary(t *testing.T) {
	// context.DeadlineExceeded happens to satisfy net.Error with
	// Timeout()==true (stdlib implements it that way), so isNetTimeout
	// returns true for it. The caller's combined check
	// `errors.Is(DeadlineExceeded) || isNetTimeout(err)` is slightly
	// redundant but the explicit Is check is kept as documentation.
	if !isNetTimeout(context.DeadlineExceeded) {
		t.Error("context.DeadlineExceeded satisfies net.Error with Timeout()==true; should match")
	}
	// context.Canceled has Timeout()==false (not a timeout, a cancel)
	// so it does NOT match isNetTimeout — caught by the caller's
	// separate errors.Is(Canceled) branch instead.
	if isNetTimeout(context.Canceled) {
		t.Error("context.Canceled has Timeout()==false; should not match isNetTimeout")
	}
	if isNetTimeout(nil) {
		t.Error("nil should not match isNetTimeout")
	}
	if isNetTimeout(errors.New("unrelated")) {
		t.Error("plain error should not match isNetTimeout")
	}
}

// fakeNetErr satisfies net.Error and reports Timeout() according to
// the embedded flag. Used to simulate transport-layer timeouts that
// don't wrap a context error (TLS handshake timeout, dial timeout).
type fakeNetErr struct {
	msg     string
	timeout bool
}

func (f *fakeNetErr) Error() string   { return f.msg }
func (f *fakeNetErr) Timeout() bool   { return f.timeout }
func (f *fakeNetErr) Temporary() bool { return false }

func TestIsNetTimeoutDirectNetError(t *testing.T) {
	// Bare net.Error with Timeout()==true (e.g. dial timeout from
	// SSRF-safe resolver).
	if !isNetTimeout(&fakeNetErr{msg: "i/o timeout", timeout: true}) {
		t.Error("direct net.Error with Timeout()==true should match")
	}
	if isNetTimeout(&fakeNetErr{msg: "connection refused", timeout: false}) {
		t.Error("net.Error with Timeout()==false should not match")
	}
}

func TestIsNetTimeoutWrappedURLError(t *testing.T) {
	// What the *http.Client returns when a TLS or dial timeout fires
	// mid-Request: *url.Error wrapping a *net.OpError that satisfies
	// net.Error. errors.As must walk through.
	wrapped := &url.Error{
		Op:  "Post",
		URL: "https://api.github.com/repos/x/y/issues",
		Err: &fakeNetErr{msg: "tls: handshake timeout", timeout: true},
	}
	if !isNetTimeout(wrapped) {
		t.Error("url.Error wrapping a net.Error.Timeout() should match")
	}
}

func TestIsNetTimeoutDeepWrap(t *testing.T) {
	// fmt.Errorf("%w", ...) wrap on top of url.Error on top of
	// net.Error — typical stack when feedback.Client.CreateIssue
	// wraps "feedback: github request: <orig>".
	inner := &fakeNetErr{msg: "i/o timeout", timeout: true}
	wrapped := fmt.Errorf("feedback: github request: %w", &url.Error{Op: "Post", URL: "x", Err: inner})
	if !isNetTimeout(wrapped) {
		t.Error("fmt.Errorf-wrapped url.Error+net.Error should match")
	}
}

func TestOutboundCtxFallsBackToBackground(t *testing.T) {
	// Handler constructed without a rootCtx (e.g. unit test setup)
	// gets context.Background() so the WithTimeout layered on top is
	// the only deadline.
	h := &FeedbackHandler{} // rootCtx nil
	ctx := h.outboundCtx()
	if ctx == nil {
		t.Fatal("outboundCtx() returned nil")
	}
	if ctx.Err() != nil {
		t.Errorf("Background context should have no error, got %v", ctx.Err())
	}
	// Deadline should be unset (Background has none).
	if d, ok := ctx.Deadline(); ok {
		t.Errorf("Background context should have no deadline, got %v", d)
	}
}

func TestOutboundCtxReturnsRootCtxWhenSet(t *testing.T) {
	root, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := &FeedbackHandler{rootCtx: root}
	ctx := h.outboundCtx()
	if ctx != root {
		t.Error("outboundCtx() should return rootCtx when set")
	}
	// Cancelling rootCtx propagates to the returned context.
	cancel()
	select {
	case <-ctx.Done():
		// expected
	case <-time.After(50 * time.Millisecond):
		t.Error("expected ctx.Done() to fire after rootCtx cancel")
	}
}
