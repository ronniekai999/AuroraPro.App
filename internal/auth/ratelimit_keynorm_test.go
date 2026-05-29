package auth

import (
	"net"
	"testing"
)

// TestNormalizeClientKey covers the audit BE-M IPv6-bypass fix: the bucket key
// must strip the port, keep IPv4 at /32, and collapse IPv6 to its /64 prefix so
// a /64 holder can't rotate the host bits to dodge the limit.
func TestNormalizeClientKey(t *testing.T) {
	cases := []struct {
		name       string
		remoteAddr string
		want       string
	}{
		{"ipv4 with port", "203.0.113.7:54321", "203.0.113.7"},
		{"ipv4 no port", "203.0.113.7", "203.0.113.7"},
		{"ipv4 different port same key", "203.0.113.7:1", "203.0.113.7"},
		// IPv4-mapped IPv6 collapses to the dotted-quad so both spellings of the
		// same address share one bucket.
		{"ipv4-mapped ipv6", "[::ffff:203.0.113.7]:443", "203.0.113.7"},
		// IPv6: the /64 prefix is the key; host bits are masked off.
		{"ipv6 with port", "[2001:db8:abcd:1234:5678:9abc:def0:1]:443", "2001:db8:abcd:1234::/64"},
		{"ipv6 no port (bracketless host)", "2001:db8:abcd:1234::1", "2001:db8:abcd:1234::/64"},
		// Malformed host that isn't an IP literal falls back to the raw host so
		// it still consumes budget (fail-closed).
		{"non-ip host", "not-an-ip", "not-an-ip"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeClientKey(tc.remoteAddr); got != tc.want {
				t.Errorf("normalizeClientKey(%q) = %q, want %q", tc.remoteAddr, got, tc.want)
			}
		})
	}
}

// TestNormalizeClientKey_IPv6SameSlash64Collapses is the core anti-bypass
// assertion: two addresses that differ only in the low 64 bits MUST map to the
// same bucket key (otherwise an attacker rotates host bits for free requests),
// while a different /64 MUST map to a distinct key.
func TestNormalizeClientKey_IPv6SameSlash64Collapses(t *testing.T) {
	a := normalizeClientKey("[2001:db8:1:2:aaaa:bbbb:cccc:dddd]:1")
	b := normalizeClientKey("[2001:db8:1:2:1111:2222:3333:4444]:2")
	if a != b {
		t.Errorf("same /64 must collapse to one key: %q != %q", a, b)
	}

	other := normalizeClientKey("[2001:db8:1:3::1]:1")
	if a == other {
		t.Errorf("different /64 must not share a key: both %q", a)
	}
}

// TestNormalizeClientKey_TrustedProxyForm locks in the proxy-rewrite shape:
// TrustedProxyMiddleware sets RemoteAddr = net.JoinHostPort(clientIP, "0"), which
// for IPv6 MUST be bracketed so /64 normalization still applies. Guards against a
// regression to the bare clientIP+":0" form that defeated masking behind a proxy.
func TestNormalizeClientKey_TrustedProxyForm(t *testing.T) {
	a := normalizeClientKey(net.JoinHostPort("2001:db8:1:2:aaaa::1", "0"))
	if a != "2001:db8:1:2::/64" {
		t.Errorf("proxy IPv6 form should mask to /64, got %q", a)
	}
	if b := normalizeClientKey(net.JoinHostPort("2001:db8:1:2:5555::9", "0")); a != b {
		t.Errorf("same /64 via proxy form must collapse: %q != %q", a, b)
	}
	if v4 := normalizeClientKey(net.JoinHostPort("203.0.113.7", "0")); v4 != "203.0.113.7" {
		t.Errorf("proxy IPv4 form, got %q", v4)
	}
}
