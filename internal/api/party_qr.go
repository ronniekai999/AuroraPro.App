package api

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	qrcode "github.com/skip2/go-qrcode"
)

// ============================================================
// Party companion-join QR code — Feature 1 (mobile companion)
// ============================================================
//
// GET /api/parties/{code}/qr.png renders a PNG QR code that encodes the
// absolute companion-join URL ( <scheme>://<host>/join/{CODE} ). A host
// displays it on the big screen; a friend scans it with their phone camera
// and lands on the mobile-companion route pre-filled with the code.
//
// AUTH (locked decision = Option A): account required. This route is
// registered inside the RequireAuth group alongside the other authed
// /api/parties/{code}/* endpoints, and additionally gated on party
// membership (host or current participant) — same policy as the reaction
// timeline / highlight reel. A random authenticated user who guesses a code
// can't mint a join QR for a party they aren't in.
//
// SECURITY — host-header injection: the encoded URL's authority comes from
// the request's Host header, which is attacker-controllable. We validate it
// against a strict character allowlist (hostname + optional :port) BEFORE
// embedding it, so a malicious Host can't smuggle a different scheme, a path,
// CRLF, or whitespace into the QR payload. A rejected host yields 400 rather
// than a QR pointing somewhere unexpected. The scheme is derived from the
// connection (or the AURORA_SECURE_COOKIES proxy hint), never from a header.

const (
	// qrImageSize is the rendered PNG edge length in pixels. 512 is large
	// enough to scan reliably off a TV across a living room while staying a
	// small payload (a join URL is short, so the QR is low-version/sparse).
	qrImageSize = 512

	// joinPathPrefix is the companion deep-link path the QR points at. The
	// server redirects /join/{code} → /v2/join/{code} (same-origin), where
	// the SPA's companion route takes over. Kept as a constant so the QR
	// payload and the redirect route can't drift apart.
	joinPathPrefix = "/join/"
)

// PartyQRHandler renders companion-join QR codes for live watch parties.
// secureCookies mirrors the auth handlers' AURORA_SECURE_COOKIES flag so the
// encoded URL gets an https scheme when Aurora sits behind a TLS-terminating
// proxy (where r.TLS is nil).
type PartyQRHandler struct {
	manager       watchpartyManager
	secureCookies bool
	// sessions decides the admin role's reach (adminPowers); nil means none.
	sessions sessionStore
}

// watchpartyManager is the subset of *watchparty.Manager this handler needs.
// Declared as an interface so the QR endpoint can be unit-tested with a tiny
// fake instead of standing up a full Manager + DB. The concrete
// *watchparty.Manager satisfies it.
type watchpartyManager interface {
	IsParticipantOrHost(code string, userID int64) bool
}

// NewPartyQRHandler constructs the handler. secureCookies should be the same
// value passed to the auth/oauth handlers (deps.Cfg ... SecureCookies) so the
// QR's scheme matches the cookies' Secure attribute behind a proxy.
func NewPartyQRHandler(manager watchpartyManager, secureCookies bool) *PartyQRHandler {
	return &PartyQRHandler{manager: manager, secureCookies: secureCookies}
}

// ServeQR handles GET /api/parties/{code}/qr.png.
func (h *PartyQRHandler) ServeQR(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(chi.URLParam(r, "code"))
	if !isValidPartyCode(code) {
		writeError(w, http.StatusBadRequest, "invalid party code")
		return
	}

	// Membership gate — only the host or a current participant may mint a
	// companion-join QR. Admins are allowed through for support/moderation,
	// mirroring GetReactions. A non-member (or a non-existent party) gets a
	// 404 so we don't confirm the existence of parties the caller isn't in.
	claims := getClaimsFromRequest(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	if !h.manager.IsParticipantOrHost(code, claims.UserID) && !adminPowers(r.Context(), h.sessions, claims) {
		writeError(w, http.StatusNotFound, "party not found")
		return
	}

	// Build the absolute companion-join URL. Host comes from the request
	// (validated); scheme comes from the connection, never a header.
	host := r.Host
	if !isSafeRequestHost(host) {
		slog.Warn("party qr: rejected unsafe Host header", "code", code, "host", host)
		writeError(w, http.StatusBadRequest, "invalid host")
		return
	}
	scheme := "http"
	if cookieSecureFor(r, h.secureCookies) {
		scheme = "https"
	}
	joinURL := scheme + "://" + host + joinPathPrefix + code

	// Encode. Medium recovery balances scannability against density; the
	// payload is short so even Medium keeps the symbol low-version (easy to
	// scan from across a room). Default black-on-white for maximum camera
	// compatibility.
	png, err := qrcode.Encode(joinURL, qrcode.Medium, qrImageSize)
	if err != nil {
		slog.Warn("party qr: encode failed", "code", code, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to generate QR code")
		return
	}

	// QR content is a function of (host, code) only — no per-user data — so
	// it is cacheable. Keep it short and private: the encoded URL is not a
	// secret (the code alone grants no access — Option A still requires
	// auth), but it shouldn't be cached by shared proxies keyed on a Host
	// that differs per deployment.
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(png)
}

// joinShortLinkRedirect handles GET /join/{code} — the companion deep link a
// phone lands on after scanning the QR. It mirrors the existing /p/{code} and
// /r/{code} short links by bouncing to the V2 SPA route, where the companion
// UI extracts the code from the path.
//
// Open-redirect safety: the Location is ALWAYS a server-relative path that
// begins "/v2/" — we never echo a caller-supplied scheme/host into it, so
// this can't be turned into an off-site redirect. chi's {code} is a single
// path segment (no slashes), and we additionally validate it to the canonical
// 6-char code shape so a percent-encoded or otherwise malformed code can't
// smuggle extra path bytes past the SPA. A code that fails validation falls
// through to /v2/ (the app shell) rather than 404ing, so a scanned-but-stale
// or mistyped link still lands somewhere usable. 302 (not 301) matches the
// rest of router.go's redirect philosophy — no permanent browser-cache lock-in
// if the SPA base ever moves off /v2/.
func joinShortLinkRedirect(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(chi.URLParam(r, "code"))
	if !isValidPartyCode(code) {
		http.Redirect(w, r, "/v2/", http.StatusFound)
		return
	}
	http.Redirect(w, r, "/v2/join/"+code, http.StatusFound)
}

// isSafeRequestHost validates an HTTP Host header before it is embedded into
// a generated URL (the QR payload). It accepts a hostname or IP, an optional
// :port, and bracketed IPv6 literals — and rejects anything that could break
// out of the authority component: schemes, paths, query/fragment, userinfo,
// whitespace, control chars (CRLF), or an empty value.
//
// This is deliberately stricter than url.Parse: we are constructing, not
// parsing, so we whitelist exactly the byte classes a legitimate authority
// uses. A reverse proxy that forwards a sane Host (the normal case) always
// passes; a forged `Host: evil.com/x?` or `Host: a\r\nSet-Cookie: ...` is
// rejected.
func isSafeRequestHost(host string) bool {
	if host == "" || len(host) > 255 {
		return false
	}
	for _, c := range host {
		switch {
		case c >= 'a' && c <= 'z':
		case c >= 'A' && c <= 'Z':
		case c >= '0' && c <= '9':
		case c == '.' || c == '-' || c == ':' || c == '[' || c == ']':
			// dot/hyphen for DNS names, colon for :port and IPv6,
			// brackets for IPv6 literals (e.g. [::1]:8080).
		default:
			return false
		}
	}
	return true
}
