package api

import (
	"bufio"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
)

// statusCapture wraps http.ResponseWriter to capture the status code.
//
// 2026-05-27 — Tracks whether WriteHeader has already been forwarded
// to the underlying writer so a second call (e.g. a handler that wrote
// an error after its context was cancelled by chi.Timeout and the
// connection was already torn down) doesn't trigger Go's "superfluous
// response.WriteHeader" warning. The underlying writer would no-op the
// second call anyway; we just stop the spurious log line.
type statusCapture struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (sc *statusCapture) WriteHeader(code int) {
	if sc.wroteHeader {
		// Already sent — drop the duplicate to avoid the stdlib
		// warning. Keep sc.status as the FIRST status (matches what
		// the client actually saw) instead of overwriting.
		return
	}
	sc.wroteHeader = true
	sc.status = code
	sc.ResponseWriter.WriteHeader(code)
}

// Write makes sure sc.wroteHeader flips to true the implicit way:
// calling Write without an explicit WriteHeader call causes net/http
// to write 200 OK first. We mirror that so a subsequent explicit
// WriteHeader call also gets suppressed.
func (sc *statusCapture) Write(b []byte) (int, error) {
	if !sc.wroteHeader {
		sc.wroteHeader = true
		// sc.status stays at the constructor default (200) — same
		// behavior as net/http's implicit-200 path.
	}
	return sc.ResponseWriter.Write(b)
}

// Unwrap exposes the wrapped ResponseWriter to http.ResponseController,
// which walks Unwrap() to reach the real connection for SetWriteDeadline /
// SetReadDeadline / EnableFullDuplex.
//
// 2026-07 streaming review — without this, every
// `http.NewResponseController(w).SetWriteDeadline(...)` in the streaming
// handlers returned http.ErrNotSupported (RequestLogger wraps ALL requests),
// so the per-request deadline extensions written for long direct-play
// transfers and slow subtitle extractions were silent no-ops and the global
// 120s WriteTimeout killed those connections anyway.
func (sc *statusCapture) Unwrap() http.ResponseWriter {
	return sc.ResponseWriter
}

// ReadFrom restores the io.ReaderFrom fast path (sendfile/splice) that
// wrapping otherwise hides: http.ServeContent/ServeFile use io.Copy, which
// only reaches sendfile when the ResponseWriter it was handed implements
// io.ReaderFrom. Direct play serves multi-gigabyte files through this path,
// so losing it meant every media byte was copied through userspace.
func (sc *statusCapture) ReadFrom(src io.Reader) (int64, error) {
	if !sc.wroteHeader {
		// Mirror Write's implicit-200 bookkeeping.
		sc.wroteHeader = true
	}
	if rf, ok := sc.ResponseWriter.(io.ReaderFrom); ok {
		return rf.ReadFrom(src)
	}
	return io.Copy(sc.ResponseWriter, src)
}

// Hijack implements http.Hijacker, required for WebSocket upgrades.
// Delegates to the underlying ResponseWriter if it supports hijacking.
func (sc *statusCapture) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := sc.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("upstream ResponseWriter does not implement http.Hijacker")
}

// Flush implements http.Flusher, required for streaming responses (SSE, chunked).
// Delegates to the underlying ResponseWriter if it supports flushing.
func (sc *statusCapture) Flush() {
	if fl, ok := sc.ResponseWriter.(http.Flusher); ok {
		fl.Flush()
	}
}

// RequestLogger is a custom middleware that logs method, path, status,
// latency, and user_id (from JWT claims if present).
//
// user_id flow: install a *requestUserHolder into the request context
// BEFORE next.ServeHTTP runs. Downstream auth middleware updates the
// holder via setRequestUserID. After ServeHTTP returns, the holder
// reflects whoever authenticated (or zero for anonymous / public).
// This pointer-in-context pattern is necessary because http.Request
// contexts are immutable per-request — see requestUserHolder docs.
func RequestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sc := &statusCapture{ResponseWriter: w, status: http.StatusOK}

		ctx, holder := auth.NewRequestContextWithUserIDHolder(r.Context())
		next.ServeHTTP(sc, r.WithContext(ctx))

		latency := time.Since(start)

		// The holder is the canonical source. We can't fall back to
		// `auth.GetClaims(r.Context())` here — r's context is the
		// outer one (before middleware), so claims are unreachable
		// from this point. Any new auth middleware MUST call
		// auth.SetRequestUserID to surface its user.
		userID := holder.Load()

		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", sc.status,
			"latency", latency.Round(time.Millisecond).String(),
			"user_id", userID,
		)
	})
}
