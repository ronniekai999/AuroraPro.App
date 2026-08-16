package api

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// The opaque-token half of the OAuth transaction fix. The database-backed half
// (create → consume → replay-refused) lives in
// internal/db/queries_oauth_txn_test.go, which needs TEST_DATABASE_URL.

// TestGenerateOAuthTxnToken_ShapeAndUniqueness pins the two properties the
// token's security rests on: it decodes to the full 32 bytes of entropy, and
// successive calls do not repeat. A truncated or repeating token would make the
// transaction row guessable, which is the whole thing the row exists to prevent.
func TestGenerateOAuthTxnToken_ShapeAndUniqueness(t *testing.T) {
	const iterations = 256
	seen := make(map[string]bool, iterations)
	for i := 0; i < iterations; i++ {
		tok, err := generateOAuthTxnToken()
		if err != nil {
			t.Fatalf("generateOAuthTxnToken: %v", err)
		}
		raw, derr := base64.RawURLEncoding.DecodeString(tok)
		if derr != nil {
			t.Fatalf("token %q is not raw-url base64: %v", tok, derr)
		}
		if len(raw) != oauthTxnTokenBytes {
			t.Fatalf("token decodes to %d bytes, want %d", len(raw), oauthTxnTokenBytes)
		}
		if seen[tok] {
			t.Fatalf("duplicate token generated after %d iterations: %q", i, tok)
		}
		seen[tok] = true
	}
}

// TestHashOAuthTxnToken pins that hashing is deterministic (so the callback can
// find the row Start wrote), that different tokens do not collide, and that the
// digest is a full SHA-256. The stored value must also differ from the token
// itself — storing the token verbatim would make a database read yield
// replayable credentials.
func TestHashOAuthTxnToken(t *testing.T) {
	const tok = "a-test-token"
	h1 := hashOAuthTxnToken(tok)
	h2 := hashOAuthTxnToken(tok)

	if len(h1) != 32 {
		t.Fatalf("digest length = %d, want 32", len(h1))
	}
	if string(h1) != string(h2) {
		t.Error("hashing must be deterministic")
	}
	if string(h1) == tok {
		t.Error("the stored digest must not be the token itself")
	}
	if string(hashOAuthTxnToken("a-test-tokeN")) == string(h1) {
		t.Error("distinct tokens must not share a digest")
	}
	// An empty token must still produce a well-formed digest rather than an
	// empty slice, which ConsumeOAuthTransaction treats as "not found".
	if len(hashOAuthTxnToken("")) != 32 {
		t.Error("empty token should still hash to 32 bytes")
	}
}

// TestSetOAuthTxnCookie_Attributes pins the cookie hardening. Path scoping
// keeps the token off every non-OAuth request, HttpOnly keeps it out of page
// scripts, and SameSite=Lax (not Strict) is required for the cookie to survive
// the provider's cross-site redirect back to the callback — Strict would drop
// it and break every OAuth flow.
func TestSetOAuthTxnCookie_Attributes(t *testing.T) {
	h := &OAuthHandler{secureCookies: true}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/start", nil)

	h.setOAuthTxnCookie(w, r, "opaque-value")

	var got *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == oauthTxnCookieName {
			got = c
			break
		}
	}
	if got == nil {
		t.Fatal("transaction cookie was not set")
	}
	if got.Value != "opaque-value" {
		t.Errorf("value = %q, want the token verbatim", got.Value)
	}
	if !got.HttpOnly {
		t.Error("cookie must be HttpOnly")
	}
	if !got.Secure {
		t.Error("cookie must carry Secure when secureCookies is on")
	}
	if got.SameSite != http.SameSiteLaxMode {
		t.Errorf("SameSite = %v, want Lax so the provider redirect still carries it", got.SameSite)
	}
	if got.Path != "/api/auth/oauth/" {
		t.Errorf("Path = %q, want the OAuth subtree", got.Path)
	}
	if got.MaxAge != oauthStateCookieMaxAge {
		t.Errorf("MaxAge = %d, want %d (same window as the state cookie)", got.MaxAge, oauthStateCookieMaxAge)
	}
}

// TestConsumeOAuthTxn_NoCookieIsCleanLogin pins that an ordinary OAuth login —
// no link, no invite, therefore no transaction — is not disturbed by the new
// machinery. This path must not touch the database, which is what makes it
// exercisable here with a nil Queries.
func TestConsumeOAuthTxn_NoCookieIsCleanLogin(t *testing.T) {
	h := &OAuthHandler{}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback?state=xyz", nil)

	out, ok := h.consumeOAuthTxn(w, r, "google", "xyz")
	if !ok {
		t.Fatal("a login with no transaction cookie must proceed")
	}
	if out.IsLink || out.LinkUID != 0 || out.InviteClaimID != 0 {
		t.Errorf("expected a zero outcome, got %+v", out)
	}
	if w.Body.Len() != 0 {
		t.Errorf("nothing should have been rendered, got: %q", w.Body.String())
	}
}

// TestConsumeOAuthTxn_EmptyCookieIsCleanLogin covers the same contract for a
// present-but-empty cookie, the shape a browser sends for a cookie the server
// previously cleared.
func TestConsumeOAuthTxn_EmptyCookieIsCleanLogin(t *testing.T) {
	h := &OAuthHandler{}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback?state=xyz", nil)
	r.AddCookie(&http.Cookie{Name: oauthTxnCookieName, Value: ""})

	out, ok := h.consumeOAuthTxn(w, r, "google", "xyz")
	if !ok {
		t.Fatal("an empty transaction cookie must be treated as absent")
	}
	if out.IsLink || out.InviteClaimID != 0 {
		t.Errorf("expected a zero outcome, got %+v", out)
	}
}

// TestOAuthTxnTTL_MatchesStateWindow pins that the row's server-side lifetime
// tracks the state cookie's window. The row is the authority — the cookie's
// MaxAge is only a hint the client may ignore — so a drift between the two
// would silently widen or narrow the real window.
//
// The TTL is a DURATION, not an absolute time: the deadline is computed by the
// database (NOW() + interval) so that both ends of the window sit on the same
// clock. Returning a time.Time here would put the deadline on the application
// clock while the consume query compares against the database clock, and a
// skewed app host would quietly widen the window.
func TestOAuthTxnTTL_MatchesStateWindow(t *testing.T) {
	if got, want := oauthTxnTTL(), time.Duration(oauthStateCookieMaxAge)*time.Second; got != want {
		t.Errorf("oauthTxnTTL() = %v, want %v", got, want)
	}
}

// TestNoForgeableIDCookiesRemain is a source-level guard against the vulnerable
// pattern coming back. The takeover was possible because a cookie's VALUE was a
// database row id; if either of those cookie names reappears in the OAuth
// handlers, someone has reintroduced the shape.
func TestNoForgeableIDCookiesRemain(t *testing.T) {
	for _, name := range []string{"aurora_oauth_link_uid", "aurora_oauth_invite_claim"} {
		for _, file := range []string{"oauth_handlers.go", "oauth_link_handlers.go", "oauth_txn.go"} {
			b, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("read %s: %v", file, err)
			}
			src := string(b)
			// The migration and comments may DISCUSS the old names; only a Go
			// string literal would make one live again.
			if strings.Contains(src, `"`+name+`"`) {
				t.Errorf("%s still declares the forgeable cookie %q — the link target and "+
					"invite claim must come from the server-side transaction row", file, name)
			}
		}
	}
}
