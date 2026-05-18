package api

import (
	"context"
	"net/http"

	"golang.org/x/oauth2"
)

// OAuth Phase A refactor — provider-agnostic plumbing.
//
// This file defines the `Provider` interface and the normalized
// `OAuthProfile` struct that every provider (Google, Discord, Twitch,
// Facebook, …) returns. The OAuthHandler holds a registry of providers
// keyed by short name and routes Start/Callback to the right one based
// on the {provider} URL parameter.
//
// Adding a new provider is now:
//   1. Implement Provider in a new file (e.g. oauth_discord.go).
//   2. Register it via OAuthHandler.RegisterProvider at construction.
//   3. Done — settings storage, route plumbing, three-tier user
//      resolution, invite-claim flow, and the success/error HTML pages
//      are all already generic.

// Provider is the contract a third-party OAuth source must satisfy to
// plug into Aurora's sign-in flow.
//
// Implementations are stateless beyond their dependencies (typically
// just *db.Queries to read settings). All per-request state — tokens,
// state cookies, invite-claim cookies — lives in OAuthHandler.
type Provider interface {
	// Name returns the short identifier used in URLs
	// (/oauth/{name}/start), settings keys (oauth_{name}_*),
	// and the `provider` column in the users table. MUST be
	// stable across builds — changing it would orphan every
	// existing user's OAuth link in the database.
	Name() string

	// Config returns an oauth2.Config ready for code exchange.
	// Returns (nil, nil) when the provider is disabled (admin
	// hasn't enabled it OR client_id/secret/redirect aren't
	// configured) — caller treats this as "feature off, 404".
	// Returns (nil, err) when settings are partially configured
	// (a misconfiguration the admin should fix).
	Config(ctx context.Context) (*oauth2.Config, error)

	// FetchUserInfo calls the provider's userinfo endpoint using
	// the authenticated HTTP client from cfg.Client(ctx, token).
	// Implementations must normalize the provider's native shape
	// into Aurora's OAuthProfile.
	FetchUserInfo(ctx context.Context, client *http.Client) (*OAuthProfile, error)

	// BypassInviteEnabled reports whether the provider's
	// invite-bypass toggle is on. When true, new-user creation
	// via this provider doesn't require an invite code. Per-
	// provider because operators may trust some identity sources
	// (Google Workspace) more than others (anonymous Discord).
	BypassInviteEnabled(ctx context.Context) bool
}

// PKCEProvider is an OPTIONAL sub-interface for providers that
// require RFC 7636 PKCE (Proof Key for Code Exchange) in their
// OAuth 2.0 flow. X/Twitter is the prominent example — they
// reject token exchanges without PKCE.
//
// Providers opt in by implementing this interface in addition to
// Provider. The Start handler type-asserts to PKCEProvider; if
// the assertion succeeds AND WantsPKCE() returns true, the handler:
//   1. Generates a random code_verifier via oauth2.GenerateVerifier().
//   2. Adds oauth2.S256ChallengeOption(verifier) to AuthCodeURL.
//   3. Stores the verifier in an HttpOnly cookie scoped to
//      /api/auth/oauth/ for the Callback to read.
//
// The Callback handler then reads the cookie, clears it, and
// passes oauth2.VerifierOption(verifier) to cfg.Exchange.
//
// Providers that don't need PKCE simply don't implement this
// interface — the type assertion fails silently and the handler
// proceeds with a plain OAuth 2.0 flow.
type PKCEProvider interface {
	Provider
	WantsPKCE() bool
}

// OAuthProfile is Aurora's normalized view of a third-party user
// profile. Every Provider.FetchUserInfo MUST populate this shape from
// the provider's native response.
//
// Required fields: Subject, Email.
// Subject is the provider's stable user ID (Google's `sub`, Discord's
// `id`, Twitch's `id`, etc.). It anchors the (provider, subject) row
// in the users table — changing it would orphan the link.
//
// EmailVerified gates the Tier-2 auto-link path in resolveOAuthUser.
// If the provider doesn't return an explicit verification signal,
// implementations should set it to FALSE (conservative). Facebook is
// the prominent example — they trust their own email but don't echo
// it; treat as unverified to avoid hijack-by-impersonation.
//
// Username (optional) lets providers with their own handle namespace
// (Twitch, Discord) suggest a username instead of the email-local-part
// default. generateUniqueUsername prefers Username when set, falls
// back to Email-local-part, then to Name.
type OAuthProfile struct {
	Subject       string
	Email         string
	EmailVerified bool
	Name          string // human-readable display name
	Username      string // provider-suggested handle (optional)
	AvatarURL     string // full URL to profile image (optional)
}
