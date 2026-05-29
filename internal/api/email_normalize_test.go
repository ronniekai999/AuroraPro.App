package api

import "testing"

// deep-debug H1 — normalizeEmail canonicalizes for case-insensitive identity.
func TestNormalizeEmail(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Bob@Corp.com", "bob@corp.com"},
		{"  USER@X.IO  ", "user@x.io"},
		{"already@low.com", "already@low.com"},
		{"MiXeD@Example.COM", "mixed@example.com"},
		{"", ""},
	}
	for _, c := range cases {
		if got := normalizeEmail(c.in); got != c.want {
			t.Errorf("normalizeEmail(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
