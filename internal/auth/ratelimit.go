package auth

import (
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/httputil"
)

// RateLimiter implements a simple per-IP token bucket rate limiter
type RateLimiter struct {
	mu       sync.Mutex
	visitors map[string]*visitor
	rate     int           // max requests
	window   time.Duration // per time window
	stop     chan struct{}
	stopOnce sync.Once // guards close(stop) so a duplicate Stop() doesn't panic
}

type visitor struct {
	count    int
	windowStart time.Time
}

func NewRateLimiter(maxRequests int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		visitors: make(map[string]*visitor),
		rate:     maxRequests,
		window:   window,
		stop:     make(chan struct{}),
	}
	// Cleanup stale entries every minute
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				rl.cleanup()
			case <-rl.stop:
				return
			}
		}
	}()
	return rl
}

// Stop terminates the background cleanup goroutine. Safe to call multiple
// times — a second call is a no-op rather than a panic.
func (rl *RateLimiter) Stop() {
	rl.stopOnce.Do(func() { close(rl.stop) })
}

func (rl *RateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	cutoff := time.Now().Add(-rl.window * 2)
	for ip, v := range rl.visitors {
		if v.windowStart.Before(cutoff) {
			delete(rl.visitors, ip)
		}
	}
}

func (rl *RateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	v, exists := rl.visitors[ip]
	if !exists || now.Sub(v.windowStart) >= rl.window {
		rl.visitors[ip] = &visitor{count: 1, windowStart: now}
		return true
	}

	v.count++
	return v.count <= rl.rate
}

// Middleware returns a chi-compatible middleware that rate limits by IP
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// RemoteAddr is the raw client address ("ip:port" for TCP).
		// We intentionally do NOT consult X-Forwarded-For / X-Real-IP here
		// because Aurora's router does not run chi.middleware.RealIP — any
		// proxy-header trust would let a remote attacker forge a unique IP
		// per request and bypass the limiter entirely.
		ip := r.RemoteAddr
		if host, _, err := net.SplitHostPort(ip); err == nil {
			ip = host
		}

		if !rl.allow(ip) {
			httputil.WriteError(w, http.StatusTooManyRequests, "rate limit exceeded, try again later")
			return
		}

		next.ServeHTTP(w, r)
	})
}
