package api

import (
	"net/http"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
)

// refreshCookiePath scopes the refresh cookie to the auth routes so it isn't
// sent on every API request — only /api/auth/* (refresh, logout). deep-debug H10.
const refreshCookiePath = "/api/auth"

// cookieSecureFor decides the Secure attribute for auth cookies: true when the
// request arrived over TLS, or when the operator declared cookies secure
// (AURORA_SECURE_COOKIES=true) for the TLS-terminating-proxy topology where
// r.TLS is nil. deep-debug H10.
func cookieSecureFor(r *http.Request, secureFlag bool) bool {
	return (r != nil && r.TLS != nil) || secureFlag
}

// writeAuthCookies sets the httpOnly access + refresh cookies. SameSite=Lax
// matches the OAuth state cookies and still withholds the cookie on cross-site
// sub-resource loads and cross-site POSTs (CSRF defense); every state-changing
// API route is POST/PUT/DELETE, so Lax is sufficient. Shared by the password
// (AuthHandler) and OAuth (OAuthHandler) login paths. deep-debug H10.
func writeAuthCookies(w http.ResponseWriter, secure bool, access string, accessTTL time.Duration, refresh string, refreshTTL time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     auth.AccessCookieName,
		Value:    access,
		Path:     "/",
		MaxAge:   int(accessTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     auth.RefreshCookieName,
		Value:    refresh,
		Path:     refreshCookiePath,
		MaxAge:   int(refreshTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// clearAuthCookiesFor expires both auth cookies. Must be called before the
// response body is written so the Set-Cookie headers land.
func clearAuthCookiesFor(w http.ResponseWriter, secure bool) {
	for _, c := range []struct{ name, path string }{
		{auth.AccessCookieName, "/"},
		{auth.RefreshCookieName, refreshCookiePath},
	} {
		http.SetCookie(w, &http.Cookie{
			Name:     c.name,
			Value:    "",
			Path:     c.path,
			MaxAge:   -1,
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
		})
	}
}

// ── AuthHandler cookie wrappers — keep the password-flow call sites unchanged ──

func (h *AuthHandler) cookieSecure(r *http.Request) bool { return cookieSecureFor(r, h.secureCookies) }

func (h *AuthHandler) setAuthCookies(w http.ResponseWriter, r *http.Request, access string, accessTTL time.Duration, refresh string, refreshTTL time.Duration) {
	writeAuthCookies(w, h.cookieSecure(r), access, accessTTL, refresh, refreshTTL)
}

func (h *AuthHandler) clearAuthCookies(w http.ResponseWriter, r *http.Request) {
	clearAuthCookiesFor(w, h.cookieSecure(r))
}
