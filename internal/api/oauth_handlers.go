package api

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/oauth2"
)

// OAuth (Phase 3 → Phase A refactor) — generic provider plumbing.
//
// Originally hardcoded for Google. The Phase A refactor extracted the
// provider-specific bits (config, userinfo fetch, settings keys, bypass
// toggle) into a Provider interface (oauth_provider.go) with Google as
// the first implementation (oauth_google.go). The handlers in this file
// are now provider-agnostic: they take the provider name from the
// {provider} URL parameter and route through the registry.
//
// Flow (same as before, parameterized by provider):
//  1. Frontend "Sign in with X" button calls GET /api/auth/oauth/{provider}/start
//  2. Backend generates a random state token, sets it as an HttpOnly cookie,
//     and 302-redirects to the provider's authorization URL with the state
//     echoed into the query string.
//  3. User signs in with the provider, provider redirects back to
//     /api/auth/oauth/{provider}/callback?code=...&state=...
//  4. Backend verifies state matches the cookie (CSRF defense), exchanges
//     the code for an access token, fetches user info via the Provider
//     implementation, and either:
//       a. finds a user by (provider, subject) — login fast path
//       b. finds a user by email — auto-link this provider's identity to
//          existing local account, ONLY if the provider reports
//          email_verified=true
//       c. creates a new OAuth-only user (empty password_hash; can sign
//          in via this provider only until they set a password)
//  5. Backend renders a tiny HTML page that stashes the issued JWT +
//     refresh tokens in localStorage and redirects to `/`. Same bridge
//     code as before.

const (
	// oauthStateCookieName holds the CSRF-defense state token. HttpOnly
	// because no JS needs to read it; Secure-when-HTTPS via Aurora's
	// usual cookie hardening.
	oauthStateCookieName = "aurora_oauth_state"

	// oauthStateCookieMaxAge: 10 minutes is enough to complete a typical
	// "click → see consent screen → accept" flow without expiring during
	// slow networks, while short enough that a stolen state token is
	// useless minutes later.
	oauthStateCookieMaxAge = 10 * 60

	// oauthJoinCookieName carries the optional ?join=<code> deep-link
	// across the OAuth round-trip. Phase 2 (share-to-story) lets users
	// land on `/?join=CODE` and auto-open the watch-party panel — but
	// the OAuth full-page navigation away from `/` discards JS state,
	// and the success-page redirect to `/` strips the query. We bridge
	// the gap with a short-lived path-scoped cookie set in Start and
	// consumed in Callback. Same hardening as the state cookie.
	oauthJoinCookieName = "aurora_oauth_join"

	// oauthInviteClaimCookieName carries the CLAIM ID (not the raw
	// invite code) of an invite that was atomically reserved in Start.
	// The Claim → Finalize 2-phase flow mirrors password registration
	// (auth_handlers.go's Register handler) — if the OAuth round-trip
	// fails for any reason, the claim is rolled back via UnclaimInviteCode
	// so the code isn't wasted. Storing the claim ID instead of the raw
	// code means the cookie can't be replayed: the code is already
	// reserved server-side once Start completes.
	oauthInviteClaimCookieName = "aurora_oauth_invite_claim"

	// oauthProviderCookieName carries the provider name across the OAuth
	// round-trip. Phase A: when callback fires we still know which
	// provider initiated the flow from the URL path itself
	// (/oauth/{provider}/callback), so this cookie is mostly informational
	// for now. Reserved for future use cases like "multi-provider state
	// reconciliation" if Start and Callback ever live on different paths.
	oauthProviderCookieName = "aurora_oauth_provider"

	// oauthPKCEVerifierCookieName carries the PKCE code_verifier
	// across the OAuth round-trip for providers that require PKCE
	// (Phase D — X/Twitter). Same hardening as the state cookie.
	// HttpOnly because the verifier is checked server-side at code-
	// exchange time, not by JS. Cleared on callback regardless of
	// outcome to enforce single-use.
	oauthPKCEVerifierCookieName = "aurora_oauth_pkce"

	// oauthLinkUIDCookieName carries the authenticated user's ID across the
	// OAuth round-trip when the flow was started in LINK mode (the Settings
	// "Connect <provider>" button, POST /oauth/{provider}/link) rather than
	// login mode. Its presence is what tells Callback "this is a link, attach
	// the identity to this existing user — do NOT issue new tokens."
	//
	// Security: the cookie is set SERVER-SIDE and HttpOnly, so an attacker
	// cannot forge or read it from JS. Callback additionally cross-checks it
	// against the caller's access cookie when that cookie is present on the
	// callback path (defense in depth — see the Callback link branch). Carved
	// out (carve-out D) — multi-provider linking.
	oauthLinkUIDCookieName = "aurora_oauth_link_uid"
)

// OAuthHandler exposes the OAuth start + callback endpoints. Depends on
// the auth Service for issuing JWT/refresh tokens after a successful
// OAuth login, on the queries layer for user lookup/create/link, and on
// a registry of providers for the actual third-party integrations.
type OAuthHandler struct {
	queries       *db.Queries
	authSvc       *auth.Service
	activity      *ActivityLogger
	providers     map[string]Provider
	secureCookies bool // deep-debug H10 — Secure attr on auth cookies behind a TLS proxy
}

// SetSecureCookies wires AURORA_SECURE_COOKIES so OAuth-login cookies get the
// Secure attribute behind a TLS-terminating proxy. deep-debug H10.
func (h *OAuthHandler) SetSecureCookies(v bool) { h.secureCookies = v }

// NewOAuthHandler constructs the handler with its dependencies and
// registers the built-in providers. Google is always registered as the
// historical default; future providers (Discord, Twitch, Facebook, X)
// follow the same RegisterProvider pattern.
func NewOAuthHandler(queries *db.Queries, authSvc *auth.Service, activity *ActivityLogger) *OAuthHandler {
	h := &OAuthHandler{
		queries:   queries,
		authSvc:   authSvc,
		activity:  activity,
		providers: make(map[string]Provider),
	}
	h.RegisterProvider(newGoogleProvider(queries))
	// Phase B providers — Discord and Twitch. Both use standard OAuth
	// 2.0 with email_verified-equivalent semantics that support the
	// full three-tier (link-by-id, auto-link-by-email, create-new)
	// flow. See oauth_discord.go / oauth_twitch.go.
	h.RegisterProvider(newDiscordProvider(queries))
	h.RegisterProvider(newTwitchProvider(queries))
	// Phase C — Facebook. Trusts Facebook's signup-time email
	// verification (industry convention; see oauth_facebook.go header).
	h.RegisterProvider(newFacebookProvider(queries))
	// Phase D — X (Twitter). Requires PKCE; emails synthetic because
	// X's free tier doesn't return real email. See oauth_twitter.go
	// header for the synthetic-email rationale.
	h.RegisterProvider(newTwitterProvider(queries))
	return h
}

// RegisterProvider adds a Provider to the registry. Must be called
// before the router starts serving — there's no concurrency
// protection on the map. Idempotent on duplicate names (last write
// wins) so reloading/re-registering during dev is safe.
func (h *OAuthHandler) RegisterProvider(p Provider) {
	h.providers[p.Name()] = p
}

// resolveProvider returns the Provider matching the {provider} URL
// param, or (nil, false) if the name isn't registered. Callers
// should respond with 404 on the bool-false case so users don't
// see implementation-detail errors.
func (h *OAuthHandler) resolveProvider(r *http.Request) (Provider, bool) {
	name := chi.URLParam(r, "provider")
	if name == "" {
		return nil, false
	}
	p, ok := h.providers[name]
	return p, ok
}

// Start handles GET /api/auth/oauth/{provider}/start.
//
// Generates a fresh state token, stashes it in an HttpOnly cookie, and
// 302-redirects to the provider's consent screen with the same state in
// the query string. The cookie + query-param echo is the standard OAuth
// CSRF defense — an attacker can't forge a complete flow against the
// victim because they can't set the victim's cookie domain.
func (h *OAuthHandler) Start(w http.ResponseWriter, r *http.Request) {
	provider, ok := h.resolveProvider(r)
	if !ok {
		writeError(w, http.StatusNotFound, "Unknown OAuth provider")
		return
	}
	cfg, err := provider.Config(r.Context())
	if err != nil {
		slog.Warn("oauth start: config invalid", "provider", provider.Name(), "error", err)
		writeError(w, http.StatusServiceUnavailable, "OAuth not configured")
		return
	}
	if cfg == nil {
		writeError(w, http.StatusNotFound, "OAuth not enabled")
		return
	}

	state, err := generateOAuthState()
	if err != nil {
		slog.Error("oauth start: generate state", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// HttpOnly because the state is checked server-side, not by JS.
	// SameSite=Lax (NOT Strict) so the cookie still rides on the
	// callback redirect from the provider — Strict would drop it
	// because the callback request originates cross-site.
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookieName,
		Value:    state,
		Path:     "/api/auth/oauth/",
		MaxAge:   oauthStateCookieMaxAge,
		HttpOnly: true,
		Secure:   cookieSecureFor(r, h.secureCookies), // deep-debug MED — Secure attr works behind a TLS-terminating proxy (r.TLS is nil there); matches renderSuccess/writeAuthCookies
		SameSite: http.SameSiteLaxMode,
	})

	// Phase A — also stash the provider name in a cookie so any future
	// callback-side reconciliation (e.g. if we ever route
	// `/oauth/callback` generically rather than per-provider) has a
	// source of truth. Today the callback path itself carries
	// {provider}, so this cookie is informational.
	http.SetCookie(w, &http.Cookie{
		Name:     oauthProviderCookieName,
		Value:    provider.Name(),
		Path:     "/api/auth/oauth/",
		MaxAge:   oauthStateCookieMaxAge,
		HttpOnly: true,
		Secure:   cookieSecureFor(r, h.secureCookies), // deep-debug MED — Secure attr works behind a TLS-terminating proxy (r.TLS is nil there); matches renderSuccess/writeAuthCookies
		SameSite: http.SameSiteLaxMode,
	})

	// Phase 2 bridge: if the caller passed ?join=CODE (a deep-link from
	// a shared social post), stash it in a path-scoped cookie so the
	// callback can preserve it through to the success-page redirect.
	// Validate: 6 chars, party-code alphabet (A-Z, 0-9). Anything else
	// is rejected silently — the user just doesn't get the auto-join,
	// but their sign-in succeeds. This also prevents reflected-URL
	// attacks where an attacker crafts a malicious ?join= value and
	// gets it surfaced verbatim in the success-page redirect.
	//
	// 2026-05-19 audit (API-H7) — the cookie value now includes the
	// state token (the same one used for CSRF defense), separated by
	// a `.`. On callback we verify the state component matches the
	// state we just validated; a stale cookie from a previous OAuth
	// flow won't decode to the current state, so the redirect won't
	// fire. Closes the "stale join cookie substitutes into an
	// unrelated flow" scenario the auditor flagged.
	if joinCode := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("join"))); isValidPartyCode(joinCode) {
		// Companion (mobile second-screen) flow: when sign-in was launched
		// from the /v2/join companion route (?companion=1), the success page
		// must bounce the phone back to the companion shell (/v2/join/CODE),
		// NOT the desktop app. Carry that intent as a third, dot-separated
		// component on the SAME cookie so it stays bound to the state token
		// (an attacker can't flip a victim's destination without also
		// matching state). Value shape: "<state>.<code>" (desktop) or
		// "<state>.<code>.c" (companion).
		cookieVal := state + "." + joinCode
		if r.URL.Query().Get("companion") == "1" {
			cookieVal += ".c"
		}
		http.SetCookie(w, &http.Cookie{
			Name:     oauthJoinCookieName,
			Value:    cookieVal,
			Path:     "/api/auth/oauth/",
			MaxAge:   oauthStateCookieMaxAge, // same lifetime as state — they must complete together
			HttpOnly: true,
			Secure:   cookieSecureFor(r, h.secureCookies), // deep-debug MED — Secure attr works behind a TLS-terminating proxy (r.TLS is nil there); matches renderSuccess/writeAuthCookies
			SameSite: http.SameSiteLaxMode,
		})
	}

	// Invite-code pre-flight: if the caller passed ?invite=CODE on the
	// register form, atomically claim it now via ClaimInviteCode. Storing
	// the CLAIM ID (not the raw code) in a path-scoped cookie means the
	// cookie can't be replayed; the code is already reserved server-side.
	// On callback we finalize the claim if a new user gets created, or
	// roll back via UnclaimInviteCode if anything fails.
	//
	// Invalid invite codes are NOT a hard failure here — we let the user
	// continue to the provider sign-in, then the callback decides based
	// on whether they're an existing user (no invite needed) or a new
	// signup (invite-or-bypass required). This way "invalid invite +
	// existing-user OAuth login" succeeds rather than spuriously failing.
	if inviteCode := strings.TrimSpace(r.URL.Query().Get("invite")); inviteCode != "" {
		if claimID, err := h.queries.ClaimInviteCode(r.Context(), inviteCode); err == nil && claimID > 0 {
			http.SetCookie(w, &http.Cookie{
				Name:     oauthInviteClaimCookieName,
				Value:    fmt.Sprintf("%d", claimID),
				Path:     "/api/auth/oauth/",
				MaxAge:   oauthStateCookieMaxAge,
				HttpOnly: true,
				Secure:   cookieSecureFor(r, h.secureCookies), // deep-debug MED — Secure attr works behind a TLS-terminating proxy (r.TLS is nil there); matches renderSuccess/writeAuthCookies
				SameSite: http.SameSiteLaxMode,
			})
		} else {
			slog.Debug("oauth start: invite code claim failed (continuing without)",
				"error", err)
		}
	}

	// Phase D — PKCE for providers that require it (X/Twitter).
	// The PKCEProvider type assertion lets us add the verifier +
	// challenge without changing the core Provider interface (most
	// providers don't need PKCE and don't implement this method).
	// The verifier rides through the round-trip in a cookie so the
	// Callback can pass it to Exchange.
	authOpts := []oauth2.AuthCodeOption{
		// `prompt=select_account` is a Google-specific param that
		// asks the provider to RE-PROMPT account picker every time
		// rather than silently sign in with the most-recent.
		// Providers that don't recognize it (Twitch, Discord, X,
		// Facebook) just ignore the param. Aurora is multi-user so
		// the ergonomic default is to let the user pick.
		oauth2.SetAuthURLParam("prompt", "select_account"),
	}
	if pkce, ok := provider.(PKCEProvider); ok && pkce.WantsPKCE() {
		verifier := oauth2.GenerateVerifier()
		authOpts = append(authOpts, oauth2.S256ChallengeOption(verifier))
		http.SetCookie(w, &http.Cookie{
			Name:     oauthPKCEVerifierCookieName,
			Value:    verifier,
			Path:     "/api/auth/oauth/",
			MaxAge:   oauthStateCookieMaxAge,
			HttpOnly: true,
			Secure:   cookieSecureFor(r, h.secureCookies), // deep-debug MED — Secure attr works behind a TLS-terminating proxy (r.TLS is nil there); matches renderSuccess/writeAuthCookies
			SameSite: http.SameSiteLaxMode,
		})
	}
	url := cfg.AuthCodeURL(state, authOpts...)
	http.Redirect(w, r, url, http.StatusFound)
}

// isValidPartyCode returns true if s is a 6-character party code in the
// generator's alphabet (A-Z, 2-9, excluding confusable 0/1/I/L/O — see
// internal/watchparty/manager.go's codeAlphabet). This is the SAME shape
// the frontend's joinPartyFromInput validates against, so we maintain a
// single notion of what a valid join target looks like. Stricter than
// strictly necessary (a user could share a code that uses confusable
// chars by typing weird) but matches what the system actually generates.
func isValidPartyCode(s string) bool {
	if len(s) != 6 {
		return false
	}
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	for _, c := range s {
		if !strings.ContainsRune(alphabet, c) {
			return false
		}
	}
	return true
}

// Callback handles GET /api/auth/oauth/{provider}/callback?code=...&state=...
//
// Validates state against the cookie, exchanges code for token, fetches
// user info via the Provider implementation, resolves to an Aurora user
// (find-by-oauth → find-by-email → create-new), issues Aurora JWT/refresh
// tokens, and renders an HTML page that bridges to the JS app.
func (h *OAuthHandler) Callback(w http.ResponseWriter, r *http.Request) {
	provider, ok := h.resolveProvider(r)
	if !ok {
		writeError(w, http.StatusNotFound, "Unknown OAuth provider")
		return
	}
	cfg, err := provider.Config(r.Context())
	if err != nil || cfg == nil {
		writeError(w, http.StatusServiceUnavailable, "OAuth not configured")
		return
	}

	// State validation (CSRF defense).
	gotState := r.URL.Query().Get("state")
	stateCookie, err := r.Cookie(oauthStateCookieName)
	if err != nil || stateCookie.Value == "" {
		slog.Warn("oauth callback: state cookie missing", "provider", provider.Name())
		h.renderError(w, "Authentication failed: missing state cookie. Please try again.")
		return
	}
	// Clear the state cookie immediately (single-use) regardless of
	// match outcome. Setting MaxAge=-1 deletes the cookie.
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookieName,
		Value:    "",
		Path:     "/api/auth/oauth/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   cookieSecureFor(r, h.secureCookies), // deep-debug MED — Secure attr works behind a TLS-terminating proxy (r.TLS is nil there); matches renderSuccess/writeAuthCookies
		SameSite: http.SameSiteLaxMode,
	})
	// Same for the provider cookie — single-use, clear on exit.
	http.SetCookie(w, &http.Cookie{
		Name:     oauthProviderCookieName,
		Value:    "",
		Path:     "/api/auth/oauth/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   cookieSecureFor(r, h.secureCookies), // deep-debug MED — Secure attr works behind a TLS-terminating proxy (r.TLS is nil there); matches renderSuccess/writeAuthCookies
		SameSite: http.SameSiteLaxMode,
	})
	if gotState == "" || gotState != stateCookie.Value {
		slog.Warn("oauth callback: state mismatch", "provider", provider.Name())
		h.renderError(w, "Authentication failed: state mismatch. Please try again.")
		return
	}

	// LINK MODE branch. If Start was invoked via POST /oauth/{provider}/link
	// (the Settings "Connect" button), it set oauthLinkUIDCookieName to the
	// authenticated user's ID. Its presence means "attach this provider to that
	// existing user" — NOT a login. We handle it entirely here and return; the
	// login path below never runs for a link flow (no tokens issued).
	if linkUID, isLink := h.readLinkUID(r); isLink {
		h.handleLinkCallback(w, r, provider, cfg, linkUID)
		return
	}

	// Exchange code + fetch profile (shared with link mode via
	// exchangeAndFetchProfile). Returns false after rendering the appropriate
	// error page, so we just return.
	profile, ok := h.exchangeAndFetchProfile(w, r, provider, cfg)
	if !ok {
		return
	}
	// Login requires a usable email (Tier-2 auto-link + Tier-3 create both key
	// off it). Link mode does NOT — see handleLinkCallback, which only requires
	// a non-empty Subject.
	if profile.Email == "" {
		slog.Warn("oauth callback: incomplete profile", "provider", provider.Name(), "subject", profile.Subject, "has_email", false)
		h.renderError(w, "Authentication failed: the provider did not return a complete profile.")
		return
	}

	// Read + clear the invite-claim cookie. Whether it's used or rolled
	// back depends on which tier of resolveOAuthUser fires: existing-user
	// paths (tier 1, 2) unclaim the reservation so the invite isn't
	// wasted; new-user creation (tier 3) consumes the claim atomically.
	var inviteClaimID int64
	if c, err := r.Cookie(oauthInviteClaimCookieName); err == nil && c.Value != "" {
		if n, perr := strconv.ParseInt(c.Value, 10, 64); perr == nil && n > 0 {
			inviteClaimID = n
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name:     oauthInviteClaimCookieName,
		Value:    "",
		Path:     "/api/auth/oauth/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   cookieSecureFor(r, h.secureCookies), // deep-debug MED — Secure attr works behind a TLS-terminating proxy (r.TLS is nil there); matches renderSuccess/writeAuthCookies
		SameSite: http.SameSiteLaxMode,
	})

	// Resolve to an Aurora user via the three-tier lookup. Pass the
	// invite-claim ID through so the tier-3 path can finalize it (and
	// tier-1/2 paths can ignore it — we'll unclaim below if it went
	// unused).
	user, isNewUser, linkErr := h.resolveOAuthUser(r.Context(), provider, profile, inviteClaimID)
	if linkErr != nil {
		// Roll back the invite claim if we have one — failed signups
		// shouldn't waste invite codes.
		if inviteClaimID > 0 {
			_ = h.queries.UnclaimInviteCode(r.Context(), inviteClaimID)
		}
		slog.Warn("oauth callback: user resolve failed", "provider", provider.Name(), "error", linkErr)
		h.renderError(w, "Authentication failed: "+linkErr.Error())
		return
	}

	// If the invite was claimed but the user already existed (tier 1 or
	// tier 2), unclaim it so the code can be used by someone else. This
	// happens when a user with a stashed invite code happens to already
	// have an Aurora account (e.g. they're linking a provider to an
	// existing account, or the email matched). The tier-3 path consumes
	// the claim via FinalizeInviteCode inside resolveOAuthUser itself.
	if inviteClaimID > 0 && !isNewUser {
		_ = h.queries.UnclaimInviteCode(r.Context(), inviteClaimID)
	}

	// Auto-create default profile for new OAuth users (mirrors auth_handlers.go:338-342).
	// Without this, a brand-new Google/Discord/etc. signup has no profiles, causing
	// GET /api/onboarding/status to return 403/404 and the TasteOnboardingGate to
	// silently skip onboarding entirely.
	if isNewUser {
		if _, err := h.queries.CreateDefaultProfileForUser(r.Context(), user.ID, user.Username); err != nil {
			// Non-fatal: user is created, profile will be created on next server start via data migration.
			_ = err
		}
	}

	// Issue tokens — same path as the password login flow.
	accessToken, expiresAt, err := h.authSvc.GenerateAccessToken(user.ID, user.Username, string(user.Role), user.TokenVersion)
	if err != nil {
		slog.Error("oauth callback: access token generate", "error", err)
		h.renderError(w, "Authentication succeeded but token issuance failed.")
		return
	}
	refreshTokenStr, err := h.authSvc.GenerateRefreshToken()
	if err != nil {
		slog.Error("oauth callback: refresh token generate", "error", err)
		h.renderError(w, "Authentication succeeded but token issuance failed.")
		return
	}
	if err := h.queries.CreateRefreshToken(r.Context(), &models.RefreshToken{
		UserID:     user.ID,
		Token:      refreshTokenStr,
		DeviceInfo: r.UserAgent(),
		ExpiresAt:  h.authSvc.RefreshTokenExpiry(),
	}); err != nil {
		slog.Error("oauth callback: refresh token persist", "error", err)
		h.renderError(w, "Authentication succeeded but token issuance failed.")
		return
	}

	if h.activity != nil {
		// IPAddress set explicitly to bring oauth_login attribution to
		// parity with password Login's activity.LogLogin call. Without
		// this, the activity_log has the user-agent but not the source
		// IP — a real forensic gap if an OAuth account is compromised.
		h.activity.log(r.Context(), &models.ActivityEntry{
			UserID:    &user.ID,
			EventType: "oauth_login",
			IPAddress: clientIP(r),
			Details: map[string]interface{}{
				"provider": provider.Name(),
			},
		})
	}

	// Stamp last_login_at for the admin Users table's "Last Login" column —
	// parity with the password Login path. Best-effort: the session is already
	// valid, so a write failure must not derail the OAuth success redirect.
	if err := h.queries.UpdateLastLogin(r.Context(), user.ID); err != nil {
		slog.Warn("oauth callback: failed to record last login", "user_id", user.ID, "err", err)
	}

	// Read + clear the join cookie (if any) for the success-page redirect.
	// Cookie was set in Start when the caller passed ?join=CODE; reading
	// here means the deep-link survives the OAuth round-trip and the user
	// lands back on /?join=CODE which initAuth's existing handler picks up.
	//
	// 2026-05-19 audit (API-H7) — cookie format is now `state.joinCode`.
	// Verify the state component matches the state we just validated for
	// CSRF before honoring the join code. Reject (treat as no-join) when
	// the prefix doesn't match — that means the cookie is from a
	// different OAuth flow and shouldn't influence this one.
	joinCode := ""
	companion := false
	if c, err := r.Cookie(oauthJoinCookieName); err == nil {
		raw := c.Value
		// Format: "<state>.<code>" (desktop) or "<state>.<code>.c" (mobile
		// companion). Verify the state component matches the one we just
		// validated, then split the remainder into code + optional marker.
		if dot := strings.IndexByte(raw, '.'); dot > 0 {
			cookieState := raw[:dot]
			rest := raw[dot+1:]
			// Optional trailing ".c" marks the companion (second-screen)
			// flow — strip it off before validating the code.
			isCompanion := false
			if i := strings.LastIndexByte(rest, '.'); i >= 0 {
				if strings.ToLower(rest[i+1:]) == "c" {
					isCompanion = true
				}
				rest = rest[:i]
			}
			cookieCode := strings.ToUpper(rest)
			// Constant-time compare on the state component so cookie
			// behavior doesn't differ between "wrong state" and
			// "missing state" — same response timing either way.
			if subtle.ConstantTimeCompare([]byte(cookieState), []byte(gotState)) == 1 && isValidPartyCode(cookieCode) {
				joinCode = cookieCode
				companion = isCompanion
			}
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name:     oauthJoinCookieName,
		Value:    "",
		Path:     "/api/auth/oauth/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   cookieSecureFor(r, h.secureCookies), // deep-debug MED — Secure attr works behind a TLS-terminating proxy (r.TLS is nil there); matches renderSuccess/writeAuthCookies
		SameSite: http.SameSiteLaxMode,
	})

	// Render the bridge HTML page (sets the httpOnly auth cookies + redirects).
	h.renderSuccess(w, r, accessToken, refreshTokenStr, expiresAt, user, joinCode, companion)
}

// clearOAuthCookie expires one of the path-scoped OAuth round-trip cookies
// (state/provider/pkce/join/invite/link). Single-use enforcement: every
// callback clears the cookies it consumed regardless of outcome. Centralized so
// the Path/HttpOnly/Secure/SameSite attributes can't drift between call sites —
// they MUST match the attributes used when the cookie was set or the browser
// won't treat it as the same cookie to delete.
func (h *OAuthHandler) clearOAuthCookie(w http.ResponseWriter, r *http.Request, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/api/auth/oauth/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   cookieSecureFor(r, h.secureCookies),
		SameSite: http.SameSiteLaxMode,
	})
}

// exchangeAndFetchProfile performs the provider code-exchange + userinfo fetch
// shared by the login Callback and the link-mode callback. It handles the
// declined-consent (empty code) case, the PKCE verifier cookie (read + single-
// use clear + required-but-missing fast-fail), and validates that the provider
// returned a non-empty Subject (the (provider, subject) anchor every flow
// needs). It also single-use-clears the link-UID cookie so a login that finds a
// stale link cookie (and an abandoned link flow) doesn't leave it lingering.
//
// On any failure it renders the appropriate error page and returns
// (nil, false); callers just return. It intentionally does NOT enforce a
// non-empty Email — that requirement is login-specific (X/Twitter use a
// synthetic email and link mode never needs one), so the login Callback checks
// Email itself after this returns.
func (h *OAuthHandler) exchangeAndFetchProfile(w http.ResponseWriter, r *http.Request, provider Provider, cfg *oauth2.Config) (*OAuthProfile, bool) {
	code := r.URL.Query().Get("code")
	if code == "" {
		// User declined consent. Render a friendly message rather than an
		// error: declining is a normal user action.
		h.renderError(w, "Sign-in cancelled. You can try again or log in with your password.")
		return nil, false
	}
	exchangeCtx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	// Phase D — PKCE handling. Audit M2 fix: ALWAYS clear the PKCE cookie,
	// regardless of whether THIS provider needs PKCE. A prior Twitter Start
	// that didn't complete may have left a verifier cookie hanging around;
	// landing here for any callback is the right moment to single-use-consume
	// it. Audit M3 fix: when the provider requires PKCE and the verifier is
	// missing, fail fast with a specific error rather than letting the
	// provider-side rejection (X: `code_verifier required`) bubble up as a
	// generic "could not exchange code" message.
	pkceVerifier := ""
	if c, cerr := r.Cookie(oauthPKCEVerifierCookieName); cerr == nil {
		pkceVerifier = c.Value
	}
	h.clearOAuthCookie(w, r, oauthPKCEVerifierCookieName)
	// Also single-use-clear the link-UID cookie here. handleLinkCallback has
	// already read it before delegating to this helper, and the login path
	// reached here only because no valid link cookie was present — clearing it
	// unconditionally guarantees a stale/garbage value can't survive a flow.
	h.clearOAuthCookie(w, r, oauthLinkUIDCookieName)

	exchangeOpts := []oauth2.AuthCodeOption{}
	if pkce, ok := provider.(PKCEProvider); ok && pkce.WantsPKCE() {
		if pkceVerifier == "" {
			slog.Warn("oauth callback: PKCE required but verifier cookie missing",
				"provider", provider.Name())
			h.renderError(w, "Authentication failed: your sign-in session timed out or cookies were cleared. Please start the sign-in flow again.")
			return nil, false
		}
		exchangeOpts = append(exchangeOpts, oauth2.VerifierOption(pkceVerifier))
	}
	token, err := cfg.Exchange(exchangeCtx, code, exchangeOpts...)
	if err != nil {
		slog.Warn("oauth callback: token exchange failed", "provider", provider.Name(), "error", err)
		h.renderError(w, "Authentication failed: could not exchange code with the provider. Please try again.")
		return nil, false
	}

	// Fetch user info via the provider's implementation. Each provider
	// normalizes its native response shape into OAuthProfile.
	profile, err := provider.FetchUserInfo(exchangeCtx, cfg.Client(exchangeCtx, token))
	if err != nil {
		slog.Warn("oauth callback: userinfo fetch failed", "provider", provider.Name(), "error", err)
		h.renderError(w, "Authentication failed: could not fetch profile from the provider.")
		return nil, false
	}
	if profile.Subject == "" {
		slog.Warn("oauth callback: incomplete profile (no subject)", "provider", provider.Name())
		h.renderError(w, "Authentication failed: the provider did not return a complete profile.")
		return nil, false
	}
	return profile, true
}

// resolveOAuthUser is the three-tier lookup: by OAuth identity (tier 1),
// then by email auto-link if verified (tier 2), then create a new user
// (tier 3). Returns (user, isNewUser, err). isNewUser=true ONLY when
// tier 3 fired — used by the caller to finalize-or-unclaim the optional
// invite-claim from the pre-flight cookie.
//
// inviteClaimID is the claim ID stashed in the oauthInviteClaimCookieName
// cookie at Start time (already atomically claimed via ClaimInviteCode).
// Tier 3 finalizes it against the new user; tier 1/2 ignore it (caller
// unclaims so the code isn't wasted). When the provider's invite-bypass
// setting is on, tier 3 doesn't need a claim — anyone with a verified
// account on that provider can sign up. When bypass is off AND no claim
// is present AND tier 3 fires, we return an error so the caller can
// render a friendly message.
func (h *OAuthHandler) resolveOAuthUser(ctx context.Context, provider Provider, profile *OAuthProfile, inviteClaimID int64) (user *models.User, isNewUser bool, err error) {
	providerName := provider.Name()
	// Canonicalize the provider email so Tier-2 auto-link (case-insensitive
	// GetUserByEmail) and Tier-3 CreateOAuthUser store/look up a consistent
	// identity. Without this a case variant created a duplicate account and
	// slipped past the email-collision anti-hijack safety net. deep-debug H1.
	profile.Email = normalizeEmail(profile.Email)

	// Tier 1: existing OAuth link. Resolves against the authoritative
	// oauth_identities table (migration 031) so any of the user's linked
	// providers hits this fast-path, not just their primary one.
	if existing, lerr := h.queries.GetUserByOAuthIdentity(ctx, providerName, profile.Subject); lerr != nil {
		return nil, false, fmt.Errorf("lookup by oauth: %w", lerr)
	} else if existing != nil {
		return existing, false, nil
	}

	// Tier 2: email match → auto-link, but only if the provider verified
	// the email. Without this check, an attacker could create a provider
	// account with someone else's email (which some providers permit for
	// unverified addresses) and take over their Aurora account.
	if profile.EmailVerified {
		if existing, lerr := h.queries.GetUserByEmail(ctx, profile.Email); lerr != nil {
			return nil, false, fmt.Errorf("lookup by email: %w", lerr)
		} else if existing != nil {
			// Insert into the authoritative oauth_identities table. Map the
			// two link sentinels to user-facing messages:
			//   - ErrOAuthIdentityConflict: the identity already belongs to a
			//     DIFFERENT Aurora user. Should be unreachable after the Tier-1
			//     miss above (Tier 1 would have returned that user), but a
			//     concurrent link could create it between the two queries — so
			//     surface it rather than silently 500.
			//   - ErrOAuthProviderAlreadyLinked: this email-matched user already
			//     linked a different account for this provider. Tell them to
			//     unlink it first from Settings.
			if lerr := h.queries.AddOAuthIdentity(ctx, existing.ID, providerName, profile.Subject); lerr != nil {
				switch {
				case errors.Is(lerr, db.ErrOAuthIdentityConflict):
					return nil, false, fmt.Errorf("this %s account is already linked to a different Aurora user", strings.Title(providerName))
				case errors.Is(lerr, db.ErrOAuthProviderAlreadyLinked):
					return nil, false, fmt.Errorf("your account already has a different %s account linked — unlink it first from Settings", strings.Title(providerName))
				default:
					return nil, false, fmt.Errorf("link oauth: %w", lerr)
				}
			}
			// Re-load to get the updated OAuth fields on the returned struct.
			updated, lerr := h.queries.GetUserByID(ctx, existing.ID)
			if lerr != nil {
				return nil, false, fmt.Errorf("reload after link: %w", lerr)
			}
			return updated, false, nil
		}
	}

	// Tier 3: NEW user creation. Gate on the provider's bypass-invite
	// setting OR a pre-flight claimed invite. The bypass setting +
	// invite claim are only checked HERE, NOT on tier 1/2 — existing-
	// user sign-ins must always succeed regardless of the invite gate
	// (otherwise an admin flipping the gate would lock out their
	// existing OAuth-linked users).
	bypassInvite := provider.BypassInviteEnabled(ctx)
	if !bypassInvite && inviteClaimID <= 0 {
		// Match the SetupStatus contract: invites are required once any
		// user exists. We don't need to re-check user count here because
		// initial-setup users go through the password Register flow, NOT
		// OAuth (no admin OAuth bootstrap path exists by design).
		//
		// The error message is user-facing — it flows through renderError
		// to the friendly HTML page. Mention the register-form invite
		// field so a user who hit "Continue with X" from the login
		// form (which has no invite field) knows what to do.
		return nil, false, fmt.Errorf("this server requires an invite code. Switch to the Register tab, enter your invite code, then click Continue with %s", strings.Title(providerName))
	}

	// The username pick is application-level TOCTOU: two concurrent
	// OAuth signups with the same email-local-part can both observe
	// "username free" and race into INSERT. Migration 017's
	// idx_users_username_lower is the only race-free guarantee, so we
	// catch the resulting 23505 unique-violation and retry once with a
	// fresh pick. Bounded to 3 attempts to prevent a runaway retry loop
	// in the degenerate case where every attempted username collides.
	for attempt := 0; attempt < 3; attempt++ {
		username, gerr := h.generateUniqueUsername(ctx, profile)
		if gerr != nil {
			return nil, false, fmt.Errorf("generate username: %w", gerr)
		}
		// CreateOAuthUserWithIdentity (migration 031) inserts the user AND its
		// first oauth_identities row in one transaction, so a new OAuth user
		// can never exist without an authoritative identity. The 23505
		// email-vs-username disambiguation below still works: the underlying
		// *pgconn.PgError from the user INSERT is propagated unchanged.
		//
		// referralPending (migration 046) is the eligibility predicate for the
		// "How did you hear about Aurora?" prompt, evaluated HERE because this
		// is the only place all of it is known: tier 3 means a genuinely new
		// user, bypassInvite means the invite gate — and with it the only
		// existing record of where the account came from — was skipped, and
		// inviteClaimID <= 0 means no invite was redeemed after all (a user can
		// present a valid invite AND use a bypassed provider; that user already
		// has attribution and the prompt would be noise). Stamped inside the
		// INSERT's transaction, so a new user can never exist eligible-but-
		// unmarked, and the rollback path below discards the mark with the user.
		referralPending := bypassInvite && inviteClaimID <= 0
		newUser, cerr := h.queries.CreateOAuthUserWithIdentity(ctx, username, profile.Email, profile.AvatarURL, providerName, profile.Subject, referralPending)
		if cerr == nil {
			// Finalize the invite claim against the new user. Mirrors the
			// password Register flow's atomic Claim → Create → Finalize
			// sequence (auth_handlers.go:269-273). If finalize fails AND
			// we'd just leave it, the claim row would sit
			// `used_at != NULL, used_by = NULL` indefinitely. A future
			// stale-claim reaper would free it for reuse, at which point
			// ONE invite code would have enrolled TWO users — exactly the
			// double-enrollment hazard invite gating exists to prevent.
			// The fix is rollback: delete the just-created user + unclaim
			// the invite + error out. Matches password Register's behavior
			// so the two paths keep the same invariant.
			//
			// Bypass mode has no claim to finalize, so this is a no-op.
			if inviteClaimID > 0 {
				if ferr := h.queries.FinalizeInviteCode(ctx, inviteClaimID, newUser.ID); ferr != nil {
					slog.Warn("oauth: invite finalize failed, rolling back user",
						"provider", providerName, "user_id", newUser.ID, "claim_id", inviteClaimID, "error", ferr)
					// Best-effort rollback. Either failure leaves a partial
					// state, but both are LESS bad than the double-enroll
					// hazard the finalize was meant to prevent.
					if _, derr := h.queries.DeleteUser(ctx, newUser.ID); derr != nil {
						slog.Warn("oauth: rollback DeleteUser failed", "user_id", newUser.ID, "error", derr)
					}
					if uerr := h.queries.UnclaimInviteCode(ctx, inviteClaimID); uerr != nil {
						slog.Warn("oauth: rollback UnclaimInviteCode failed", "claim_id", inviteClaimID, "error", uerr)
					}
					return nil, false, fmt.Errorf("invite finalize failed: %w", ferr)
				}
			}
			return newUser, true, nil
		}
		// Only retry on a Postgres unique-violation (23505). Anything
		// else (FK violation, syntax, connection error) bubbles up
		// as-is — those errors don't get better with a different
		// username.
		var pgErr *pgconn.PgError
		if !errors.As(cerr, &pgErr) || pgErr.Code != "23505" {
			return nil, false, fmt.Errorf("create oauth user: %w", cerr)
		}
		// Audit H5 — distinguish email-vs-username collision. Both
		// are 23505 unique-violations, but only the username case
		// benefits from retry (the username generator picks a new
		// candidate each iteration). An email collision means the
		// user already exists with this email but a DIFFERENT
		// provider link — retrying with a new username doesn't fix
		// that, just produces N misleading "username collision"
		// logs and a confusing "exhausted retries" error.
		//
		// The constraint name varies by Postgres version + migration
		// — covers `users_email_key`, the more recent
		// `idx_users_email_lower` (migration 028 unique-on-lower index),
		// and any future `email` substring. Defensive matching.
		if isEmailUniqueConstraint(pgErr.ConstraintName) {
			return nil, false, fmt.Errorf("an account with email %s already exists. Sign in with your password first, then link %s from your profile", profile.Email, providerName)
		}
		slog.Debug("oauth: username collision, retrying",
			"provider", providerName, "attempted_username", username, "attempt", attempt+1)
	}
	return nil, false, fmt.Errorf("create oauth user: exhausted retries on username collision")
}

// isEmailUniqueConstraint matches the variety of constraint names
// Postgres might report for the users.email uniqueness invariant.
// Defensive against migration-driven renames.
func isEmailUniqueConstraint(name string) bool {
	if name == "" {
		return false
	}
	n := strings.ToLower(name)
	return strings.Contains(n, "email")
}

// generateUniqueUsername picks a username from the provider's profile
// data. Preference order: provider-supplied Username (Twitch handle,
// Discord username) > email local-part > sanitized display name. On
// collision, suffixes a numeric counter (foo, foo2, foo3, …).
func (h *OAuthHandler) generateUniqueUsername(ctx context.Context, profile *OAuthProfile) (string, error) {
	// Prefer the provider's native handle when present (Twitch, Discord
	// have stable handles; Google does not — leaves Username empty).
	base := sanitizeUsername(profile.Username)
	if base == "" {
		// Fall back to email local-part.
		e := profile.Email
		if at := strings.Index(e, "@"); at > 0 {
			e = e[:at]
		}
		base = sanitizeUsername(e)
	}
	if base == "" && profile.Name != "" {
		base = sanitizeUsername(profile.Name)
	}
	if base == "" {
		base = "user"
	}

	// Try the bare base first, then base2, base3, ... bare attempts
	// are bounded to 10 (most common-name collisions resolve here).
	// After that we pivot to a random 6-char suffix to short-circuit
	// the "popular email local-part" DoS surface — without this an
	// attacker could pre-register foo, foo2, ... foo100 to force
	// future OAuth signups for "foo@anywhere.com" through 100
	// sequential DB roundtrips. Random suffix means O(1) attempts
	// per signup regardless of how many sequential names are taken.
	//
	// 2026-05-19 audit (API-M2).
	const linearAttempts = 10
	for i := 0; i < linearAttempts; i++ {
		candidate := base
		if i > 0 {
			candidate = fmt.Sprintf("%s%d", base, i+1)
		}
		existing, err := h.queries.GetUserByUsername(ctx, candidate)
		if err != nil {
			return "", err
		}
		if existing == nil {
			return candidate, nil
		}
	}
	// Random-suffix attempts. 36^6 = ~2 billion candidates; collision
	// probability vs ~10K existing usernames is ~5e-6 per attempt,
	// so 10 attempts effectively guarantees a hit.
	for i := 0; i < 10; i++ {
		var buf [4]byte
		if _, err := rand.Read(buf[:]); err != nil {
			return "", fmt.Errorf("generate random suffix: %w", err)
		}
		// 32-bit value → 6-char base36 string (zero-padded).
		n := uint32(buf[0])<<24 | uint32(buf[1])<<16 | uint32(buf[2])<<8 | uint32(buf[3])
		candidate := fmt.Sprintf("%s_%06s", base, strconv.FormatUint(uint64(n%2176782336), 36))
		existing, err := h.queries.GetUserByUsername(ctx, candidate)
		if err != nil {
			return "", err
		}
		if existing == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not find unique username after %d linear + 10 random attempts", linearAttempts)
}

// sanitizeUsername strips characters that aren't safe-for-username:
// keeps a-z, 0-9, underscore; lowercases. Conservative on purpose —
// safer to drop a character than encode unicode quirks.
func sanitizeUsername(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		case r == '.', r == '-', r == '+':
			// Common email-local separators — map to underscore so
			// "foo.bar" → "foo_bar" rather than disappearing.
			b.WriteRune('_')
		}
	}
	return b.String()
}

// generateOAuthState produces a cryptographically random 32-byte state
// token, hex-encoded. Used as the OAuth `state` query param + matched
// against the HttpOnly cookie on callback.
func generateOAuthState() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// renderSuccess sets the httpOnly auth cookies server-side (deep-debug H10 —
// same as the password login flow) and returns a small HTML page that stashes
// ONLY the cached user in localStorage (for the SPA's optimistic boot render)
// and redirects to `/` (or `/?join=CODE` if a deep-link survived the OAuth
// round-trip via the join cookie). Tokens are NO LONGER written to localStorage.
//
// The page is templated so we can safely inject the user value without risk of
// HTML injection — html/template auto-escapes all expressions in their
// respective contexts (JS-context inside <script>, URL-context for redirect).
func (h *OAuthHandler) renderSuccess(w http.ResponseWriter, r *http.Request, accessToken, refreshToken string, expiresAt time.Time, user *models.User, joinCode string, companion bool) {
	// Marshal the user as JSON for localStorage. Match the legacy
	// /api/auth/login response shape so the frontend's existing post-
	// login bootstrap code-path works without modification.
	userJSON, err := json.Marshal(user)
	if err != nil {
		slog.Error("oauth success render: marshal user", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	const successHTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing you in…</title>
<style>
body{background:#0c0a18;color:#f4f0ff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:40px;border:1px solid rgba(167,139,250,0.25);border-radius:12px;background:rgba(255,255,255,0.02)}
.spinner{width:40px;height:40px;margin:0 auto 16px;border:3px solid rgba(167,139,250,0.2);border-top-color:#a78bfa;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<div class="box"><div class="spinner"></div><div>Signing you in…</div></div>
<script>
try{
  // deep-debug H10 — tokens are set as httpOnly cookies server-side; only the
  // cached user is stashed for the SPA's optimistic boot render.
  localStorage.setItem('aurora_user', {{.UserJSON}});
}catch(e){}
// Preserve any deep-link query (e.g. ?join=ABCDEF survives OAuth round-trip
// via the start endpoint's query forwarding).
var dest = {{.RedirectTo}};
window.location.replace(dest);
</script>
</body></html>`

	tpl, err := template.New("oauth-success").Parse(successHTML)
	if err != nil {
		slog.Error("oauth success render: template parse", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Build the redirect destination. If a join code came through (Phase 2
	// deep-link), append it as a query param so the frontend's existing
	// initAuth handler auto-opens the party panel post-login. isValidPartyCode
	// already constrained the value at Start time, so concatenating it here
	// is safe — but html/template's URL-context escaping will protect us
	// even if that validation ever drifts.
	redirectTo := "/"
	if joinCode != "" {
		if companion {
			// Mobile companion sign-in: bounce the phone to the second-
			// screen companion route, NOT the desktop app. joinCode is
			// already constrained to [A-Z0-9]{6} by isValidPartyCode, so
			// this is a fixed-shape, same-origin path — no open redirect.
			redirectTo = "/v2/join/" + joinCode
		} else {
			redirectTo = "/?join=" + joinCode
		}
	}

	// deep-debug H10 — set the httpOnly auth cookies server-side (the OAuth
	// success path is now cookie-based like password login; tokens are no
	// longer written to localStorage). Set-Cookie must precede the body write.
	writeAuthCookies(w, cookieSecureFor(r, h.secureCookies), accessToken, time.Until(expiresAt), refreshToken, time.Until(h.authSvc.RefreshTokenExpiry()))

	// Override the strict `/api/*` CSP set by the securityHeaders middleware
	// (default-src 'none' would block the inline <script> + <style> below,
	// leaving the user stuck on the "Signing you in…" spinner forever
	// because the localStorage-write + window.location.replace JS never
	// runs). The bridge page body is fully server-controlled (no user
	// content rendered as raw JS — html/template's JS-context escaping
	// safely handles tokens + user fields) and the page runs once before
	// redirecting, so 'unsafe-inline' on script/style is acceptable here.
	// The strict API CSP still applies to every other /api/* endpoint.
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; "+
			"script-src 'unsafe-inline'; "+
			"style-src 'unsafe-inline'; "+
			"frame-ancestors 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = tpl.Execute(w, map[string]interface{}{
		"UserJSON":   string(userJSON),
		"RedirectTo": redirectTo,
	})
}

// renderError shows a user-facing error page with a "back to sign-in"
// link. Used for any OAuth-flow failure that the user might retry.
func (h *OAuthHandler) renderError(w http.ResponseWriter, message string) {
	const errorHTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign-in failed</title>
<style>
body{background:#0c0a18;color:#f4f0ff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:40px;max-width:480px;border:1px solid rgba(255,89,89,0.3);border-radius:12px;background:rgba(255,89,89,0.05)}
.icon{font-size:32px;margin-bottom:12px}
.msg{margin-bottom:20px;line-height:1.5}
.btn{display:inline-block;padding:10px 20px;background:#a78bfa;color:#0c0a18;border-radius:8px;text-decoration:none;font-weight:600}
.btn:hover{background:#9061f9}
</style></head><body>
<div class="box"><div class="icon">⚠</div><div class="msg">{{.Message}}</div><a href="/" class="btn">Back to sign-in</a></div>
</body></html>`

	tpl, err := template.New("oauth-error").Parse(errorHTML)
	if err != nil {
		http.Error(w, message, http.StatusBadRequest)
		return
	}
	// Override the strict `/api/*` CSP. The error page has no inline
	// script — only inline <style> — so style-src 'unsafe-inline' is
	// sufficient. Without this override the page renders as unstyled
	// black text on a white background (the styles get blocked) which
	// looks broken and obscures the actual error message.
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; "+
			"style-src 'unsafe-inline'; "+
			"frame-ancestors 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusBadRequest)
	_ = tpl.Execute(w, map[string]string{"Message": message})
}
