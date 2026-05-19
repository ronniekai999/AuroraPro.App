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

// maxVisitors caps the visitors map size. Without this cap a botnet
// sending requests from many unique IPs could fill the map (~100 B
// per entry × millions of IPs) faster than the 1-minute cleanup
// ticker drains it. When the cap is hit, allow() evicts old entries
// aggressively so the map can never grow unbounded.
//
// 2026-05-19 audit (BE-M9).
const maxVisitors = 10_000

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
		// 2026-05-19 audit (BE-M9) — bound the map size. If we're
		// at the cap and the requesting IP isn't already in the
		// map, evict any expired entries inline before inserting.
		// This makes the worst-case (botnet of unique IPs) O(N)
		// once per cap-rollover instead of forever-growing memory.
		if !exists && len(rl.visitors) >= maxVisitors {
			cutoff := now.Add(-rl.window * 2)
			for k, vv := range rl.visitors {
				if vv.windowStart.Before(cutoff) {
					delete(rl.visitors, k)
				}
			}
			// If still over cap, drop the oldest entry. map iteration
			// order is randomized so this is effectively random
			// eviction — acceptable for a DoS-defense layer.
			if len(rl.visitors) >= maxVisitors {
				for k := range rl.visitors {
					delete(rl.visitors, k)
					break
				}
			}
		}
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
