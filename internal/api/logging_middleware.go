package api

import (
	"bufio"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
)

// statusCapture wraps http.ResponseWriter to capture the status code.
type statusCapture struct {
	http.ResponseWriter
	status int
}

func (sc *statusCapture) WriteHeader(code int) {
	sc.status = code
	sc.ResponseWriter.WriteHeader(code)
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
