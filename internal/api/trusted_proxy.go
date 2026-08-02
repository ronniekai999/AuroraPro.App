package api

import (
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
)

// TrustedProxyMiddleware returns a chi middleware that consults
// X-Forwarded-For / X-Real-IP ONLY when the immediate TCP peer (RemoteAddr)
// is in the trusted-proxy allowlist. When the peer is untrusted (or no
// proxies are configured), it leaves r.RemoteAddr alone — so the auth rate
// limiter and any other RemoteAddr-keyed logic see the real source IP.
//
// trustedCIDRs is the parsed allowlist; pass nil/empty to disable proxy
// trust entirely (the secure default).
//
// This deliberately does NOT use chi.middleware.RealIP, which trusts those
// headers from anyone — a remote attacker could forge them to spoof
// arbitrary source IPs and bypass per-IP rate limits.
func TrustedProxyMiddleware(trustedCIDRs []*net.IPNet) func(http.Handler) http.Handler {
	var warnOnce sync.Once
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if len(trustedCIDRs) == 0 {
				// Detect the silent misconfiguration: a reverse proxy IS in
				// front of us (it set X-Forwarded-For) but we're not
				// configured to trust anything, so RemoteAddr is the proxy's
				// loopback address for EVERY request. The per-IP auth rate
				// limiter then collapses into a single shared bucket, and
				// audit logs record 127.0.0.1 instead of the real client —
				// which is exactly what production shows on every
				// refresh-replay warning.
				//
				// Warn ONCE. This is a per-request path and the condition is
				// permanent until an operator changes config; logging per
				// request would bury the very logs it's complaining about.
				if r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("X-Real-IP") != "" {
					warnOnce.Do(func() {
						slog.Warn("reverse proxy detected but trusted_proxies is empty — "+
							"every request looks like it comes from the proxy, so the per-IP auth "+
							"rate limiter shares ONE bucket across all clients and audit logs record "+
							"the proxy's address. Set AURORA_TRUSTED_PROXIES (e.g. 127.0.0.1/32,::1/128 "+
							"for a local nginx) in /etc/aurora/aurora.env and restart.",
							"peer", r.RemoteAddr,
							"forwarded_for", r.Header.Get("X-Forwarded-For"))
					})
				}
				next.ServeHTTP(w, r)
				return
			}

			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				host = r.RemoteAddr
			}
			peerIP := net.ParseIP(host)
			if peerIP == nil || !ipInCIDRs(peerIP, trustedCIDRs) {
				next.ServeHTTP(w, r)
				return
			}

			// Peer is trusted. Take the value our OWN proxy contributed —
			// never a value the client could have chosen.
			//
			// This used to take the LEFT-most X-Forwarded-For entry, on the
			// reasoning that XFF reads "client, proxy1, proxy2" so the client
			// is first. That is true only when every hop is trustworthy. The
			// nginx this repo ships sets
			//
			//     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
			//
			// which expands to "$http_x_forwarded_for, $remote_addr" — it
			// APPENDS the real client to whatever XFF the client sent. So the
			// left-most entry is entirely attacker-controlled: sending
			// "X-Forwarded-For: 10.0.0.<n>" yields a fresh rate-limit bucket
			// per request and defeats the 10/min login limiter completely.
			//
			// The right-most entry is the one our trusted proxy appended, and
			// X-Real-IP is set by the same nginx directly from $remote_addr.
			// Prefer X-Real-IP (unambiguous), fall back to right-most XFF.
			//
			// Trade-off, deliberately chosen: behind MULTIPLE proxies (a CDN
			// in front of nginx) this yields the CDN's address rather than the
			// end user's, so clients bucket together and the limiter gets
			// stricter than intended. That fails CLOSED. Left-most fails OPEN
			// — an outright bypass — and for a security control the closed
			// failure is the only acceptable one.
			var clientIP string
			if xri := r.Header.Get("X-Real-IP"); xri != "" {
				clientIP = strings.TrimSpace(xri)
			} else if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
				if i := strings.LastIndexByte(xff, ','); i >= 0 {
					clientIP = strings.TrimSpace(xff[i+1:])
				} else {
					clientIP = strings.TrimSpace(xff)
				}
			}

			if clientIP != "" && net.ParseIP(clientIP) != nil {
				// Rewrite RemoteAddr with the resolved client IP. Use
				// net.JoinHostPort so an IPv6 client is bracketed
				// ("[2001:db8::1]:0"): a bare clientIP+":0" yields an
				// unparseable 9-colon string that net.SplitHostPort rejects,
				// which silently defeated the rate limiter's IPv6 /64
				// normalization behind a trusted proxy. deep-debug MED.
				r.RemoteAddr = net.JoinHostPort(clientIP, "0")
			}
			next.ServeHTTP(w, r)
		})
	}
}

func ipInCIDRs(ip net.IP, cidrs []*net.IPNet) bool {
	for _, c := range cidrs {
		if c.Contains(ip) {
			return true
		}
	}
	return false
}

// ParseTrustedProxyCIDRs parses each CIDR string and logs+drops any that
// fail to parse. Returns the survivors. Operators get a startup log line
// per malformed entry so misconfiguration is loud and immediate.
func ParseTrustedProxyCIDRs(raw []string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(raw))
	for _, s := range raw {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		// Accept either "x.x.x.x" (single IP → /32) or full CIDR.
		if !strings.Contains(s, "/") {
			if strings.Contains(s, ":") {
				s += "/128"
			} else {
				s += "/32"
			}
		}
		_, n, err := net.ParseCIDR(s)
		if err != nil {
			slog.Warn("trusted_proxies: ignoring invalid CIDR", "value", s, "error", err)
			continue
		}
		out = append(out, n)
	}
	return out
}
