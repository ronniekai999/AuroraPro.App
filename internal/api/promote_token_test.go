package api

import "testing"

// TestShouldPromoteToken pins which paths may authenticate via a ?token= query
// param (promoted to an Authorization header). The highlight-reel case is the
// regression for audit H11: the reel is opened via an <a href> that cannot
// carry an Authorization header, so without promotion the request always 401'd.
func TestShouldPromoteToken(t *testing.T) {
	promote := []string{
		"/ws/party-sync",
		"/ws/party-room",
		"/api/stream/abc123/master.m3u8",
		"/api/images/w500/poster.jpg",
		"/api/admin/backup",
		"/api/parties/ABCD12/highlight.mp4", // audit H11
	}
	for _, p := range promote {
		if !shouldPromoteToken(p) {
			t.Errorf("shouldPromoteToken(%q) = false; want true", p)
		}
	}

	deny := []string{
		"/api/parties/ABCD12/reactions",           // sibling party route keeps header-only auth
		"/api/parties/ABCD12",                     // party metadata
		"/api/parties/ABCD12/highlight.mp4/extra", // trailing segment — exact match only
		"/api/media/123",
		"/api/auth/login",
		"/api/admin/settings", // secret-bearing; must never accept ?token=
		// audit H11 follow-up: r.URL.Path is NOT cleaned, so the matcher must
		// reject traversal / multi-segment / non-alphanumeric-code paths that a
		// loose prefix+suffix check would have wrongly promoted.
		"/api/parties/../admin/backup/highlight.mp4",
		"/api/parties/x/y/highlight.mp4",
		"/api/parties//highlight.mp4",
		"/api/parties/AB CD/highlight.mp4",
	}
	for _, p := range deny {
		if shouldPromoteToken(p) {
			t.Errorf("shouldPromoteToken(%q) = true; want false", p)
		}
	}
}
