package config

import (
	"reflect"
	"testing"
)

// TrustedProxies was YAML-only, which made it unreachable in the managed
// deployment (configured entirely through /etc/aurora/aurora.env). Left unset
// behind the nginx that setup-domain.sh installs, every request arrives with
// RemoteAddr 127.0.0.1 — the per-IP auth rate limiter collapses into one
// shared bucket for the whole internet, and audit logs record the proxy
// instead of the client. Production showed exactly that: client_ip=127.0.0.1
// on every refresh-replay warning.
//
// The parser is lenient about bare IPs on purpose. A bare IP is what an
// operator will naturally write, and silently ignoring it would leave the
// limiter degraded while the config LOOKS correct — the worst possible
// failure mode for a security control.
func TestParseTrustedProxies(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{
			name: "what install.sh writes",
			in:   "127.0.0.1/32,::1/128",
			want: []string{"127.0.0.1/32", "::1/128"},
		},
		{
			name: "bare IPv4 becomes a single-host CIDR",
			in:   "127.0.0.1",
			want: []string{"127.0.0.1/32"},
		},
		{
			name: "bare IPv6 becomes a single-host CIDR",
			in:   "::1",
			want: []string{"::1/128"},
		},
		{
			name: "mixed bare and CIDR",
			in:   "127.0.0.1,10.0.0.0/8,::1",
			want: []string{"127.0.0.1/32", "10.0.0.0/8", "::1/128"},
		},
		{
			name: "whitespace tolerated",
			in:   " 127.0.0.1/32 , ::1/128 ",
			want: []string{"127.0.0.1/32", "::1/128"},
		},
		{
			name: "empty entries dropped",
			in:   "127.0.0.1/32,,",
			want: []string{"127.0.0.1/32"},
		},
		{
			name: "empty string yields nothing",
			in:   "",
			want: []string{},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parseTrustedProxies(tc.in)
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("parseTrustedProxies(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// Malformed entries must not be silently normalised into something valid —
// they are passed through for ParseTrustedProxyCIDRs to reject and log.
func TestParseTrustedProxies_MalformedPassedThrough(t *testing.T) {
	got := parseTrustedProxies("not-an-ip")
	if len(got) != 1 || got[0] != "not-an-ip/32" {
		t.Fatalf("got %v — malformed input should survive to the CIDR parser, which logs and drops it", got)
	}
}
