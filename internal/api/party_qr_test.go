package api

import (
	"bytes"
	"context"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
)

// fakeQRManager is a stand-in for *watchparty.Manager that lets the QR
// handler test assert membership-gating without a real Manager + DB. It
// records the (code, userID) it was asked about and returns a canned answer.
type fakeQRManager struct {
	member    bool
	gotCode   string
	gotUserID int64
}

func (f *fakeQRManager) IsParticipantOrHost(code string, userID int64) bool {
	f.gotCode = code
	f.gotUserID = userID
	return f.member
}

// qrRequest builds a GET /api/parties/{code}/qr.png request with the given
// chi {code} param, host, and (optionally) authenticated claims. Pass
// claims=nil to simulate an unauthenticated caller.
func qrRequest(code, host string, claims *auth.JWTClaims) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/parties/"+code+"/qr.png", nil)
	r.Host = host
	if claims != nil {
		r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
	}
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("code", code)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

func memberClaims() *auth.JWTClaims {
	return &auth.JWTClaims{UserID: 7, Username: "ronnie", Role: "user"}
}

// TestPartyQR_Success — a party member gets a 200 with a real PNG.
func TestPartyQR_Success(t *testing.T) {
	mgr := &fakeQRManager{member: true}
	h := NewPartyQRHandler(mgr, false)

	rec := httptest.NewRecorder()
	h.ServeQR(rec, qrRequest("ABCDEF", "aurora.example.com", memberClaims()))

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200; body=%q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}
	// Body must be a decodable PNG (not just bytes with the right header).
	img, err := png.Decode(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("response body is not a valid PNG: %v", err)
	}
	if b := img.Bounds(); b.Dx() != qrImageSize || b.Dy() != qrImageSize {
		t.Errorf("PNG is %dx%d, want %dx%d", b.Dx(), b.Dy(), qrImageSize, qrImageSize)
	}
	// The handler should have membership-gated on the upper-cased code and
	// the authenticated user id.
	if mgr.gotCode != "ABCDEF" || mgr.gotUserID != 7 {
		t.Errorf("membership check got (%q,%d), want (ABCDEF,7)", mgr.gotCode, mgr.gotUserID)
	}
}

// TestPartyQR_LowercaseCodeUppercased — the URL code is case-normalized to the
// canonical uppercase form before the membership check and encoding.
func TestPartyQR_LowercaseCodeUppercased(t *testing.T) {
	mgr := &fakeQRManager{member: true}
	h := NewPartyQRHandler(mgr, false)

	rec := httptest.NewRecorder()
	h.ServeQR(rec, qrRequest("abcdef", "host.local", memberClaims()))

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200", rec.Code)
	}
	if mgr.gotCode != "ABCDEF" {
		t.Errorf("membership check got code %q, want ABCDEF (uppercased)", mgr.gotCode)
	}
}

// TestPartyQR_NonMember — a logged-in user who isn't in the party gets 404
// (existence is not confirmed to non-members).
func TestPartyQR_NonMember(t *testing.T) {
	mgr := &fakeQRManager{member: false}
	h := NewPartyQRHandler(mgr, false)

	rec := httptest.NewRecorder()
	h.ServeQR(rec, qrRequest("ABCDEF", "host.local", memberClaims()))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("got status %d, want 404", rec.Code)
	}
}

// TestPartyQR_AdminBypassesMembership — admins are allowed through for
// support/moderation even if not a participant (mirrors GetReactions).
func TestPartyQR_AdminBypassesMembership(t *testing.T) {
	mgr := &fakeQRManager{member: false}
	h := NewPartyQRHandler(mgr, false)
	h.sessions = fakeSessions{acting: &models.UserProfile{ID: 1}}

	admin := &auth.JWTClaims{UserID: 1, Username: "admin", Role: "admin"}
	rec := httptest.NewRecorder()
	h.ServeQR(rec, qrRequest("ABCDEF", "host.local", admin))

	if rec.Code != http.StatusOK {
		t.Fatalf("admin got status %d, want 200; body=%q", rec.Code, rec.Body.String())
	}
}

// TestPartyQR_Unauthenticated — no claims in context → 401.
func TestPartyQR_Unauthenticated(t *testing.T) {
	mgr := &fakeQRManager{member: true}
	h := NewPartyQRHandler(mgr, false)

	rec := httptest.NewRecorder()
	h.ServeQR(rec, qrRequest("ABCDEF", "host.local", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got status %d, want 401", rec.Code)
	}
}

// TestPartyQR_InvalidCode — codes that aren't the canonical 6-char shape are
// rejected with 400 before any membership check.
func TestPartyQR_InvalidCode(t *testing.T) {
	cases := []string{
		"ABC",       // too short
		"ABCDEFG",   // too long
		"ABC!EF",    // illegal char
		"ABC0EF",    // 0 is a confusable excluded from the alphabet
		"../secret", // path-traversal attempt
		"",          // empty
	}
	for _, code := range cases {
		t.Run(code, func(t *testing.T) {
			mgr := &fakeQRManager{member: true}
			h := NewPartyQRHandler(mgr, false)
			rec := httptest.NewRecorder()
			h.ServeQR(rec, qrRequest(code, "host.local", memberClaims()))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("code %q: got status %d, want 400", code, rec.Code)
			}
			if mgr.gotCode != "" {
				t.Errorf("code %q: membership check ran (%q) before validation", code, mgr.gotCode)
			}
		})
	}
}

// TestPartyQR_HostHeaderInjectionRejected — a forged Host that tries to break
// out of the URL authority (path bytes, CRLF, whitespace) is rejected with
// 400 rather than baked into the encoded QR payload.
func TestPartyQR_HostHeaderInjectionRejected(t *testing.T) {
	cases := []string{
		"evil.com/phish",       // path smuggling
		"evil.com?x=1",         // query smuggling
		"evil.com#frag",        // fragment
		"a\r\nSet-Cookie: x=y", // CRLF / header injection
		"has space.com",        // whitespace
		"user@evil.com",        // userinfo
		"http://evil.com",      // scheme smuggling
	}
	for _, host := range cases {
		t.Run(host, func(t *testing.T) {
			mgr := &fakeQRManager{member: true}
			h := NewPartyQRHandler(mgr, false)
			rec := httptest.NewRecorder()
			h.ServeQR(rec, qrRequest("ABCDEF", host, memberClaims()))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("host %q: got status %d, want 400", host, rec.Code)
			}
		})
	}
}

// TestPartyQR_SafeHostsAccepted — legitimate Host shapes (DNS name, name:port,
// IPv4:port, bracketed IPv6:port) are accepted.
func TestPartyQR_SafeHostsAccepted(t *testing.T) {
	cases := []string{
		"aurora.example.com",
		"aurora.example.com:8080",
		"192.168.1.50:9090",
		"[::1]:8080",
		"localhost",
	}
	for _, host := range cases {
		t.Run(host, func(t *testing.T) {
			mgr := &fakeQRManager{member: true}
			h := NewPartyQRHandler(mgr, false)
			rec := httptest.NewRecorder()
			h.ServeQR(rec, qrRequest("ABCDEF", host, memberClaims()))
			if rec.Code != http.StatusOK {
				t.Fatalf("host %q: got status %d, want 200; body=%q", host, rec.Code, rec.Body.String())
			}
		})
	}
}

// ============================================================
// /join/{code} short-link redirect
// ============================================================

// joinRequest builds a GET /join/{code} request with the chi {code} param set.
func joinRequest(code string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/join/"+code, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("code", code)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// TestJoinRedirect_ValidCode — /join/{CODE} → /v2/join/{CODE}, same-origin
// (relative Location, no host/scheme), 302.
func TestJoinRedirect_ValidCode(t *testing.T) {
	rec := httptest.NewRecorder()
	joinShortLinkRedirect(rec, joinRequest("ABCDEF"))

	if rec.Code != http.StatusFound {
		t.Fatalf("got status %d, want 302", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if loc != "/v2/join/ABCDEF" {
		t.Errorf("Location = %q, want /v2/join/ABCDEF", loc)
	}
	assertSameOrigin(t, loc)
}

// TestJoinRedirect_LowercaseUppercased — a lowercase code is normalized to the
// canonical uppercase form in the redirect target.
func TestJoinRedirect_LowercaseUppercased(t *testing.T) {
	rec := httptest.NewRecorder()
	joinShortLinkRedirect(rec, joinRequest("abcdef"))

	if loc := rec.Header().Get("Location"); loc != "/v2/join/ABCDEF" {
		t.Errorf("Location = %q, want /v2/join/ABCDEF", loc)
	}
}

// TestJoinRedirect_InvalidCodeFallsThrough — a malformed code redirects to the
// app shell (/v2/) rather than 404ing, and never produces an off-site or
// path-smuggled Location.
func TestJoinRedirect_InvalidCodeFallsThrough(t *testing.T) {
	cases := []string{
		"ABC",           // too short
		"ABCDEFG",       // too long
		"ABC0EF",        // confusable char not in alphabet
		"%2e%2e%2fevil", // encoded traversal
		"evil",          // wrong shape
	}
	for _, code := range cases {
		t.Run(code, func(t *testing.T) {
			rec := httptest.NewRecorder()
			joinShortLinkRedirect(rec, joinRequest(code))
			if rec.Code != http.StatusFound {
				t.Fatalf("code %q: got status %d, want 302", code, rec.Code)
			}
			loc := rec.Header().Get("Location")
			if loc != "/v2/" {
				t.Errorf("code %q: Location = %q, want /v2/", code, loc)
			}
			assertSameOrigin(t, loc)
		})
	}
}

// assertSameOrigin fails the test if loc is not a server-relative path (i.e.
// it has a scheme or host, or is protocol-relative "//host"). Guards against
// an open-redirect regression.
func assertSameOrigin(t *testing.T, loc string) {
	t.Helper()
	if loc == "" {
		t.Fatal("empty Location")
	}
	if len(loc) == 0 || loc[0] != '/' {
		t.Errorf("Location %q is not server-relative", loc)
	}
	if len(loc) >= 2 && loc[1] == '/' {
		t.Errorf("Location %q is protocol-relative (open-redirect risk)", loc)
	}
}
