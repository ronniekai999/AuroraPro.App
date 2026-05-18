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

// RequestLogger is a custom middleware that logs method, path, status, latency,
// and user_id (from JWT claims if present).
func RequestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sc := &statusCapture{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(sc, r)

		latency := time.Since(start)

		var userID int64
		if claims := auth.GetClaims(r.Context()); claims != nil {
			userID = claims.UserID
		}

		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", sc.status,
			"latency", latency.Round(time.Millisecond).String(),
			"user_id", userID,
		)
	})
}
