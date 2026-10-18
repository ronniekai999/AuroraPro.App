package api

import (
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"golang.org/x/oauth2"
)

// Authenticated multi-provider OAuth linking endpoints (audit carve-out D).
//
// These three handlers + the link-mode callback let a signed-in user manage
// which OAuth providers are connected to their account, on top of the
// authoritative oauth_identities table (migration 031):
//
//	GET    /api/auth/oauth/links            — list linked + available providers
//	POST   /api/auth/oauth/{provider}/link  — begin linking a provider (LINK MODE)
//	DELETE /api/auth/oauth/{provider}/link  — unlink a provider (LOCKOUT-GUARDED)
//
// All three sit behind RequireAuth. The link START sets the SAME CSRF cookies
// as the login Start, plus an opaque transaction cookie whose server-side row
// records the caller's user ID; the shared Callback consumes that row and
// branches into handleLinkCallback instead of the login/token path. The DELETE
// refuses to remove a user's LAST sign-in method.

// oauthLinkResponse is the GET /links payload. `available` is the set of
// configured-but-not-yet-linked providers the UI can offer a "Connect" button
// for; `linked` is what the user already connected (with when). hasPassword +
// canUnlinkAny let the UI decide whether "Disconnect" is allowed without a
// second round-trip.
type oauthLinkResponse struct {
	Linked       []oauthLinkedProvider `json:"linked"`
	Available    []string              `json:"available"`
	HasPassword  bool                  `json:"hasPassword"`
	CanUnlinkAny bool                  `json:"canUnlinkAny"`
}

type oauthLinkedProvider struct {
	Provider string    `json:"provider"`
	LinkedAt time.Time `json:"linkedAt"`
}

// configuredProviders returns the registered providers whose Config currently
// resolves to an enabled, fully-configured oauth2.Config (i.e. the admin turned
// them on and filled in client_id/secret/redirect). A provider that's
// registered but disabled is omitted — the UI shouldn't offer a "Connect"
// button for a provider the operator hasn't enabled. Returned sorted for a
// stable UI ordering.
func (h *OAuthHandler) configuredProviders(r *http.Request) map[string]bool {
	out := make(map[string]bool, len(h.providers))
	for name, p := range h.providers {
		cfg, err := p.Config(r.Context())
		if err == nil && cfg != nil {
			out[name] = true
		}
	}
	return out
}

// LinksStatus handles GET /api/auth/oauth/links (RequireAuth). Reports the
// caller's linked providers, the providers still available to link, whether
// they have a password (a non-OAuth sign-in method), and whether any unlink is
// currently permitted by the lockout guard.
func (h *OAuthHandler) LinksStatus(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}

	identities, err := h.queries.ListOAuthIdentities(r.Context(), claims.UserID)
	if err != nil {
		slog.Error("oauth links: list identities", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "could not load linked accounts")
		return
	}
	user, err := h.queries.GetUserByID(r.Context(), claims.UserID)
	if err != nil {
		slog.Error("oauth links: load user", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "could not load account")
		return
	}
	if user == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	hasPassword := user.PasswordHash != ""

	linked := make([]oauthLinkedProvider, 0, len(identities))
	linkedSet := make(map[string]bool, len(identities))
	for _, id := range identities {
		linked = append(linked, oauthLinkedProvider{Provider: id.Provider, LinkedAt: id.CreatedAt})
		linkedSet[id.Provider] = true
	}

	// available = configured-and-enabled providers minus the ones already
	// linked. Sorted for deterministic UI ordering.
	available := make([]string, 0)
	for name := range h.configuredProviders(r) {
		if !linkedSet[name] {
			available = append(available, name)
		}
	}
	sort.Strings(available)

	// canUnlinkAny mirrors the DELETE lockout guard: an unlink is allowed iff
	// it wouldn't leave the user with zero sign-in methods. With a password,
	// any single identity can go; without one, you need >1 identity so at
	// least one OAuth login remains.
	canUnlinkAny := hasPassword || len(identities) > 1

	writeJSON(w, http.StatusOK, oauthLinkResponse{
		Linked:       linked,
		Available:    available,
		HasPassword:  hasPassword,
		CanUnlinkAny: canUnlinkAny,
	})
}

// StartLink handles POST /api/auth/oauth/{provider}/link (RequireAuth) — the
// LINK-MODE counterpart to Start. It validates the provider is known + enabled,
// generates a CSRF state, sets the same state/provider/PKCE cookies Start sets,
// plus a link-mode transaction recording the authenticated user's ID so the
// shared Callback knows to attach (not log in). It returns {auth_url: ...} as
// JSON rather than 302-redirecting, because the SPA performs the navigation
// itself (window.location = auth_url) from a fetch() call.
//
// It deliberately does NOT set the join/invite cookies — those only make sense
// for a login/signup flow, never for linking onto an already-authenticated
// account.
func (h *OAuthHandler) StartLink(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	if denyRestrictedSession(w, r, h.queries, claims) {
		return
	}
	provider, ok := h.resolveProvider(r)
	if !ok {
		writeError(w, http.StatusNotFound, "Unknown OAuth provider")
		return
	}
	cfg, err := provider.Config(r.Context())
	if err != nil {
		slog.Warn("oauth link start: config invalid", "provider", provider.Name(), "error", err)
		writeError(w, http.StatusServiceUnavailable, "OAuth not configured")
		return
	}
	if cfg == nil {
		writeError(w, http.StatusNotFound, "OAuth not enabled")
		return
	}

	state, err := generateOAuthState()
	if err != nil {
		slog.Error("oauth link start: generate state", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	secure := cookieSecureFor(r, h.secureCookies)
	// State cookie — same shape/lifetime as the login Start so the shared
	// Callback's state validation works identically.
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookieName,
		Value:    state,
		Path:     "/api/auth/oauth/",
		MaxAge:   oauthStateCookieMaxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     oauthProviderCookieName,
		Value:    provider.Name(),
		Path:     "/api/auth/oauth/",
		MaxAge:   oauthStateCookieMaxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
	// Link-mode marker. The authenticated caller's user id is recorded in a
	// server-side transaction row and the client receives only the opaque
	// token that addresses it; the presence of a link-mode transaction is what
	// flips Callback into handleLinkCallback.
	//
	// The id used to be the cookie's literal value. HttpOnly kept page scripts
	// from reading it but placed no constraint at all on what a caller could
	// SEND, so substituting a victim's id here attached the attacker's
	// provider identity to the victim's account. Bound to `state` so the row
	// is usable only by the flow it was minted for.
	// Retire any transaction left over from an earlier flow before minting
	// this one — most importantly an abandoned invited signup, whose pending
	// claim this cookie is the only handle to.
	h.releaseStaleOAuthTxn(r.Context(), r)

	linkUID := claims.UserID
	if err := h.startOAuthTxn(r.Context(), w, r,
		db.OAuthTxnModeLink, provider.Name(), state, &linkUID, nil); err != nil {
		slog.Error("oauth link start: create transaction",
			"provider", provider.Name(), "user_id", linkUID, "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	authOpts := []oauth2.AuthCodeOption{
		oauth2.SetAuthURLParam("prompt", "select_account"),
	}
	// PKCE providers (X/Twitter) need the verifier cookie in link mode too.
	if pkce, ok := provider.(PKCEProvider); ok && pkce.WantsPKCE() {
		verifier := oauth2.GenerateVerifier()
		authOpts = append(authOpts, oauth2.S256ChallengeOption(verifier))
		http.SetCookie(w, &http.Cookie{
			Name:     oauthPKCEVerifierCookieName,
			Value:    verifier,
			Path:     "/api/auth/oauth/",
			MaxAge:   oauthStateCookieMaxAge,
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"auth_url": cfg.AuthCodeURL(state, authOpts...),
	})
}

// Unlink handles DELETE /api/auth/oauth/{provider}/link (RequireAuth) with the
// LOCKOUT GUARD: it refuses to remove a provider if doing so would leave the
// user with NO way to sign in. A user authenticates either by password or by an
// OAuth identity; removing their last identity when they have no password would
// permanently lock them out of their own account. So we reject (409) when
// `!hasPassword && nIdentities <= 1`. The provider name is validated against
// the registry so a typo'd provider returns 404 rather than a confusing 200.
func (h *OAuthHandler) Unlink(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	if denyRestrictedSession(w, r, h.queries, claims) {
		return
	}
	provider, ok := h.resolveProvider(r)
	if !ok {
		writeError(w, http.StatusNotFound, "Unknown OAuth provider")
		return
	}
	providerName := provider.Name()

	// Lockout guard inputs: how many identities the user has, and whether they
	// have a password fallback.
	nIdentities, err := h.queries.CountOAuthIdentities(r.Context(), claims.UserID)
	if err != nil {
		slog.Error("oauth unlink: count identities", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "could not unlink account")
		return
	}
	user, err := h.queries.GetUserByID(r.Context(), claims.UserID)
	if err != nil {
		slog.Error("oauth unlink: load user", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "could not unlink account")
		return
	}
	if user == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	hasPassword := user.PasswordHash != ""

	// The guard. Note we check BEFORE deleting so we never half-strip a user's
	// only credential.
	if wouldLockOutUnlink(hasPassword, nIdentities) {
		writeError(w, http.StatusConflict,
			"can't disconnect your only sign-in method — set a password first, or link another provider")
		return
	}

	removed, err := h.queries.RemoveOAuthIdentity(r.Context(), claims.UserID, providerName)
	if err != nil {
		slog.Error("oauth unlink: remove identity", "user_id", claims.UserID, "provider", providerName, "error", err)
		writeError(w, http.StatusInternalServerError, "could not unlink account")
		return
	}
	if !removed {
		writeError(w, http.StatusNotFound, "provider not linked")
		return
	}

	if h.activity != nil {
		uid := claims.UserID
		h.activity.log(r.Context(), &models.ActivityEntry{
			UserID:    &uid,
			EventType: "oauth_unlink",
			IPAddress: clientIP(r),
			Details:   map[string]interface{}{"provider": providerName},
		})
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// wouldLockOutUnlink reports whether unlinking one provider would leave the
// user with NO way to sign in. A user authenticates via a password OR via an
// OAuth identity; removing the LAST identity from a passwordless user locks them
// out for good. So unlinking is forbidden exactly when the user has no password
// AND has at most one identity. Pulled out as a pure function so the security-
// critical invariant is unit-testable without a database. (<= 1 not == 1: the
// 0-identity case has nothing to remove and 404s downstream, but treating it as
// "locked out" here is harmless and keeps the predicate total.)
func wouldLockOutUnlink(hasPassword bool, nIdentities int) bool {
	return !hasPassword && nIdentities <= 1
}

// handleLinkCallback is the LINK-MODE branch of Callback: the user is already
// signed in and chose to connect a provider, so we attach the identity to
// linkUID and redirect back to the app — NO new tokens are issued, renderSuccess
// is never called.
//
// linkUID does NOT come from the request. Callback recovered it by consuming
// the server-side transaction row that StartLink wrote from a verified session,
// so the caller had no opportunity to choose it. On top of that we require the
// caller to still hold a live session for that account — see
// linkSessionMatches, which fails closed where the old cross-check fell through
// to trusting the (then client-writable) cookie.
func (h *OAuthHandler) handleLinkCallback(w http.ResponseWriter, r *http.Request, provider Provider, cfg *oauth2.Config, linkUID int64) {
	providerName := provider.Name()

	// Require a live session for the account being linked. This catches both
	// the benign case (the user logged out or switched accounts in another tab
	// mid-link, which should abort rather than attach the provider to whoever
	// the transaction names) and the adversarial one (somebody replaying a
	// transaction token they should not hold).
	if !h.linkSessionMatches(r.Context(), r, linkUID) {
		slog.Warn("oauth link callback: no live session for link target",
			"provider", providerName, "link_uid", linkUID)
		h.renderError(w, "Session changed or expired during linking. Sign in and try again from Settings.")
		return
	}

	// Exchange + fetch profile via the shared helper (also single-use-clears
	// the PKCE cookie). Link mode requires only a non-empty Subject,
	// which the helper already validated — the email-verified gate does NOT
	// apply here because the user is authenticated and explicitly chose to link.
	profile, ok := h.exchangeAndFetchProfile(w, r, provider, cfg)
	if !ok {
		return
	}

	// Attach the identity. Map the conflict sentinels to user-facing messages
	// (same wording as resolveOAuthUser's Tier-2 link errors for consistency).
	if err := h.queries.AddOAuthIdentity(r.Context(), linkUID, providerName, profile.Subject); err != nil {
		switch {
		case errors.Is(err, db.ErrOAuthIdentityConflict):
			h.renderError(w, fmt.Sprintf("This %s account is already linked to a different Aurora user.", strings.Title(providerName)))
		case errors.Is(err, db.ErrOAuthProviderAlreadyLinked):
			h.renderError(w, fmt.Sprintf("You already have a different %s account linked. Disconnect it first, then try again.", strings.Title(providerName)))
		default:
			slog.Error("oauth link callback: add identity", "provider", providerName, "user_id", linkUID, "error", err)
			h.renderError(w, "Could not link the account. Please try again.")
		}
		return
	}

	if h.activity != nil {
		uid := linkUID
		h.activity.log(r.Context(), &models.ActivityEntry{
			UserID:    &uid,
			EventType: "oauth_link",
			IPAddress: clientIP(r),
			Details:   map[string]interface{}{"provider": providerName},
		})
	}

	h.renderLinkSuccess(w, r, providerName)
}

// renderLinkSuccess renders a small HTML bridge page for a completed link. It
// does NOT issue tokens (the user is already authenticated) — it just redirects
// back into the SPA with ?linked=<provider> so the Connected Accounts UI can
// show a success toast and refresh. Mirrors renderSuccess's CSP override +
// html/template escaping, minus the localStorage/token writes.
func (h *OAuthHandler) renderLinkSuccess(w http.ResponseWriter, r *http.Request, providerName string) {
	const linkHTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Account linked</title>
<style>
body{background:#0c0a18;color:#f4f0ff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:40px;border:1px solid rgba(167,139,250,0.25);border-radius:12px;background:rgba(255,255,255,0.02)}
.spinner{width:40px;height:40px;margin:0 auto 16px;border:3px solid rgba(167,139,250,0.2);border-top-color:#a78bfa;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<div class="box"><div class="spinner"></div><div>Account linked — returning to Aurora…</div></div>
<script>
var dest = {{.RedirectTo}};
window.location.replace(dest);
</script>
</body></html>`

	tpl, err := template.New("oauth-link-success").Parse(linkHTML)
	if err != nil {
		slog.Error("oauth link success render: template parse", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Redirect into the SPA settings with a ?linked marker. providerName comes
	// from our own registry (validated by resolveProvider), but route it
	// through html/template's URL-context escaping anyway for defense in depth.
	redirectTo := "/?linked=" + providerName

	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; "+
			"script-src 'unsafe-inline'; "+
			"style-src 'unsafe-inline'; "+
			"frame-ancestors 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = tpl.Execute(w, map[string]interface{}{"RedirectTo": redirectTo})
}
