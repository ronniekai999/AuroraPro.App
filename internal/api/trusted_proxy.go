package api

import (
	"log/slog"
	"net"
	"net/http"
	"strings"
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
// arbitrary source IPs and bypass per-IP rate limits. Each trusted edge proxy
// must also overwrite client-supplied forwarding headers (Aurora's nginx
// template does); appending an untrusted incoming XFF would preserve a forged
// left-most address.
func TrustedProxyMiddleware(trustedCIDRs []*net.IPNet) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if len(trustedCIDRs) == 0 {
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

			// Peer is trusted; honor a single header value (no chained
			// XFF traversal — that just multiplies the spoofing surface).
			// XFF takes precedence over X-Real-IP; both are common.
			var clientIP string
			if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
				// XFF is "client, proxy1, proxy2, ..." — left-most is the
				// originating client. We trust only the left-most because
				// each entry past the first is set by upstream proxies we
				// haven't validated.
				if i := strings.IndexByte(xff, ','); i >= 0 {
					clientIP = strings.TrimSpace(xff[:i])
				} else {
					clientIP = strings.TrimSpace(xff)
				}
			} else if xri := r.Header.Get("X-Real-IP"); xri != "" {
				clientIP = strings.TrimSpace(xri)
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
