package llm

import (
	"net"
	"testing"
)

func TestIsBlockedLLMTargetIP(t *testing.T) {
	tests := []struct {
		name    string
		ip      string
		blocked bool
	}{
		{name: "metadata IPv4", ip: "169.254.169.254", blocked: true},
		{name: "link local IPv4", ip: "169.254.1.10", blocked: true},
		{name: "link local IPv6", ip: "fe80::1", blocked: true},
		{name: "unspecified IPv4", ip: "0.0.0.0", blocked: true},
		{name: "loopback allowed", ip: "127.0.0.1", blocked: false},
		{name: "private docker allowed", ip: "172.17.0.2", blocked: false},
		{name: "public allowed", ip: "8.8.8.8", blocked: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isBlockedLLMTargetIP(net.ParseIP(tt.ip))
			if got != tt.blocked {
				t.Fatalf("isBlockedLLMTargetIP(%s) = %v, want %v", tt.ip, got, tt.blocked)
			}
		})
	}
}
