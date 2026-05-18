package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/aurora-media/aurora/internal/db"
	"golang.org/x/oauth2"
)

// Facebook OAuth 2.0 provider (Phase C).
//
// Facebook uses standard OAuth 2.0 via their Graph API. Scopes are
// `email` + `public_profile` — basic access that doesn't require
// "advanced access" review for production apps in most regions.
// (Some regions still require app review for `email`; admins should
// expect to submit for review before going live.)
//
// API version pinning: Facebook deprecates Graph API versions on a
// 2-year cadence. Pin to a specific version in the URL so behavior
// is stable across our release cycle — currently v18.0 (released
// Sep 2023, supported through ~Sep 2025). Bump when needed.
//
// EmailVerified posture: CONSERVATIVE (false).
//
// Facebook does NOT return a per-user `email_verified` field. They
// nominally verify email at signup (since ~2014), but Aurora can't
// confirm that for any individual response. Without an explicit
// verification signal, we treat the email as UNVERIFIED — which
// means Tier 2 (email auto-link) is SKIPPED for Facebook sign-ins.
//
// Consequence: a user with an existing Aurora password account at
// `alice@example.com` who signs in with Facebook (where their
// account is configured with the same email) will hit Tier 3
// (create-new), which will fail with a UNIQUE-violation on the
// users.email column. resolveOAuthUser detects this constraint
// name specifically and renders a user-friendly error explaining
// "this email is already on file — sign in with your password
// first, then link Facebook from your profile." This is intended
// safer-than-convention behavior to avoid the account-hijack
// vector where a third party could create a Facebook account with
// the target's email and slip into Tier 2 auto-link.
//
// Operators who would rather trust Facebook's email (and accept the
// hijack risk in exchange for smoother UX) can patch this provider's
// FetchUserInfo to set EmailVerified=true. We're conservative by
// default per security best practice.
//
// Avatar URL: Facebook serves profile photos via Graph API at a
// canonical URL — we construct it from the user ID rather than
// asking the API for the URL (saves a round trip). The URL is
// publicly accessible without auth.
//
// Settings keys (parallel to other providers):
//   oauth_facebook_enabled       — "true" or anything else (off)
//   oauth_facebook_client_id     — App ID from developers.facebook.com
//   oauth_facebook_client_secret — App Secret
//   oauth_facebook_redirect_url  — must match the OAuth redirect URI
//                                   registered on the FB app
//                                   (case-sensitive; both http and
//                                   https work but FB requires HTTPS
//                                   for production)
//   oauth_facebook_bypass_invite — "true" skips invite requirement

const (
	settingOAuthFacebookEnabled      = "oauth_facebook_enabled"
	settingOAuthFacebookClientID     = "oauth_facebook_client_id"
	settingOAuthFacebookClientSecret = "oauth_facebook_client_secret"
	settingOAuthFacebookRedirectURL  = "oauth_facebook_redirect_url"
	settingOAuthFacebookBypassInvite = "oauth_facebook_bypass_invite"
)

// Facebook's API version pinned to keep behavior stable.
// golang.org/x/oauth2/facebook ships an Endpoint with older v3.2-
// era URLs; we override to a current pinned version so behavior
// doesn't drift when the upstream package bumps. Facebook also
// accepts unversioned URLs (graph.facebook.com/oauth/...) which
// silently follow "current latest" — we explicitly avoid that for
// reproducibility.
var facebookEndpoint = oauth2.Endpoint{
	AuthURL:   "https://www.facebook.com/v18.0/dialog/oauth",
	TokenURL:  "https://graph.facebook.com/v18.0/oauth/access_token",
	AuthStyle: oauth2.AuthStyleInParams,
}

type facebookProvider struct {
	queries *db.Queries
}

func newFacebookProvider(queries *db.Queries) *facebookProvider {
	return &facebookProvider{queries: queries}
}

func (p *facebookProvider) Name() string { return "facebook" }

func (p *facebookProvider) Config(ctx context.Context) (*oauth2.Config, error) {
	enabled, _ := p.queries.GetSetting(ctx, settingOAuthFacebookEnabled)
	if enabled != "true" {
		return nil, nil
	}
	clientID, _ := p.queries.GetSetting(ctx, settingOAuthFacebookClientID)
	clientSecret, _ := p.queries.GetSetting(ctx, settingOAuthFacebookClientSecret)
	redirectURL, _ := p.queries.GetSetting(ctx, settingOAuthFacebookRedirectURL)
	if clientID == "" || clientSecret == "" || redirectURL == "" {
		return nil, fmt.Errorf("oauth: facebook client_id, client_secret, and redirect_url must all be set")
	}
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  redirectURL,
		Scopes:       []string{"email", "public_profile"},
		Endpoint:     facebookEndpoint,
	}, nil
}

// FetchUserInfo calls Facebook's /me endpoint and normalizes the
// response. We explicitly request the `id,name,email` fields
// because Graph API returns the minimum projection by default.
func (p *facebookProvider) FetchUserInfo(ctx context.Context, client *http.Client) (*OAuthProfile, error) {
	req, err := http.NewRequestWithContext(ctx, "GET",
		"https://graph.facebook.com/v18.0/me?fields=id,name,email", nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("userinfo returned status %d", resp.StatusCode)
	}
	var raw struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode userinfo: %w", err)
	}

	// Avatar URL: Facebook serves profile photos at a canonical
	// Graph URL. `type=large` is ~200px; `type=normal` is ~100px.
	// `redirect=false` returns JSON with a `data.url` field — but
	// we use the redirect form because it's GET-cacheable and
	// browsers handle 302 transparently. Public URL, no auth.
	avatarURL := ""
	if raw.ID != "" {
		avatarURL = fmt.Sprintf("https://graph.facebook.com/%s/picture?type=large", raw.ID)
	}

	return &OAuthProfile{
		Subject: raw.ID,
		Email:   raw.Email,
		// Audit H3 — conservative: Facebook returns no per-user
		// `email_verified` signal, so we treat as unverified.
		// Tier 2 auto-link is intentionally skipped; users with
		// existing accounts will need to sign in with their
		// password and link Facebook from profile. See file header
		// for the security rationale.
		EmailVerified: false,
		Name:          raw.Name,
		// Facebook doesn't have a separate stable handle namespace
		// — leave Username empty so generateUniqueUsername falls
		// back to email local-part.
		Username:  "",
		AvatarURL: avatarURL,
	}, nil
}

func (p *facebookProvider) BypassInviteEnabled(ctx context.Context) bool {
	v, _ := p.queries.GetSetting(ctx, settingOAuthFacebookBypassInvite)
	return v == "true"
}
