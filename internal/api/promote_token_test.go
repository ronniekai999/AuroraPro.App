package api

import "testing"

// TestShouldPromoteToken pins which paths may authenticate via a ?token= query
// param (promoted to an Authorization header).
//
// Security review 2026-06 (watch-party report, finding 1) — the highlight-reel
// path was REMOVED from the promote list (superseding audit H11). The reel
// link is a same-origin <a href> whose GET carries the httpOnly access cookie
// (post-H10), so the route authenticates with no credential in the URL;
// promoting there only enabled the SPA's login-JWT-in-URL leak.
func TestShouldPromoteToken(t *testing.T) {
	promote := []string{
		"/ws/party-sync",
		"/ws/party-room",
		"/api/stream/abc123/master.m3u8",
		"/api/images/w500/poster.jpg",
		"/api/admin/backup",
	}
	for _, p := range promote {
		if !shouldPromoteToken(p) {
			t.Errorf("shouldPromoteToken(%q) = false; want true", p)
		}
	}

	deny := []string{
		"/api/parties/ABCD12/highlight.mp4",       // 2026-06 — cookie-authed; JWT-in-URL leak closed
		"/api/parties/ABCD12/reactions",           // sibling party route keeps header-only auth
		"/api/parties/ABCD12",                     // party metadata
		"/api/parties/ABCD12/highlight.mp4/extra", // trailing segment — never promoted
		"/api/media/123",
		"/api/auth/login",
		"/api/admin/settings", // secret-bearing; must never accept ?token=
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
