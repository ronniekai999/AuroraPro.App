package main

import (
	"testing"
	"time"
)

// TestRevokedTokenRetentionOutlivesAccessTokens: a revoked session row must
// outlast every access token minted from it.
func TestRevokedTokenRetentionOutlivesAccessTokens(t *testing.T) {
	for _, ttl := range []time.Duration{0, 15 * time.Minute, time.Hour} {
		if got := revokedTokenRetention(ttl); got <= ttl {
			t.Errorf("access tokens live %v but revoked rows only %v", ttl, got)
		}
	}
}
