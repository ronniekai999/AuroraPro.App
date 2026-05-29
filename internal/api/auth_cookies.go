package api

import (
	"net/http"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
)

// refreshCookiePath scopes the refresh cookie to the auth routes so it isn't
// sent on every API request — only /api/auth/* (refresh, logout). deep-debug H10.
const refreshCookiePath = "/api/auth"

// cookieSecure decides the Secure attribute for auth cookies: true when the
// request arrived over TLS, or when the operator declared cookies secure
// (AURORA_SECURE_COOKIES=true) for the TLS-terminating-proxy topology where
// r.TLS is nil. deep-debug H10.
func (h *AuthHandler) cookieSecure(r *http.Request) bool {
	return r.TLS != nil || h.secureCookies
}

// setAuthCookies writes the httpOnly access + refresh cookies. SameSite=Lax
// matches the OAuth cookies and still withholds the cookie on cross-site
// sub-resource loads and cross-site POSTs (CSRF defense); every state-changing
// API route is POST/PUT/DELETE, so Lax is sufficient. deep-debug H10.
func (h *AuthHandler) setAuthCookies(w http.ResponseWriter, r *http.Request, access string, accessTTL time.Duration, refresh string, refreshTTL time.Duration) {
	secure := h.cookieSecure(r)
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

// clearAuthCookies expires both auth cookies (logout / failed refresh). Must be
// called before the response body is written so the Set-Cookie headers land.
func (h *AuthHandler) clearAuthCookies(w http.ResponseWriter, r *http.Request) {
	secure := h.cookieSecure(r)
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
