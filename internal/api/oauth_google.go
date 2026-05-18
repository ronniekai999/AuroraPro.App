package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/aurora-media/aurora/internal/db"
	"golang.org/x/oauth2"
	googleoauth "golang.org/x/oauth2/google"
)

// Google OAuth 2.0 + OpenID Connect provider.
//
// Reads settings from server_settings on every request rather than
// captured at boot, so the admin UI can toggle credentials without a
// restart. The handful of DB hits per login is negligible.
//
// Settings keys (all under server_settings, value column TEXT):
//   oauth_google_enabled       — "true" or anything else (off)
//   oauth_google_client_id     — Google Cloud Console OAuth 2.0 Client ID
//   oauth_google_client_secret — paired secret (stored plaintext;
//                                same protection model as the
//                                radarr/sonarr API keys)
//   oauth_google_redirect_url  — must match the URI registered in the
//                                Google Cloud Console verbatim
//   oauth_google_bypass_invite — "true" skips invite requirement on
//                                NEW user creation via this provider

const (
	settingOAuthGoogleEnabled      = "oauth_google_enabled"
	settingOAuthGoogleClientID     = "oauth_google_client_id"
	settingOAuthGoogleClientSecret = "oauth_google_client_secret"
	settingOAuthGoogleRedirectURL  = "oauth_google_redirect_url"
	settingOAuthGoogleBypassInvite = "oauth_google_bypass_invite"
)

// googleProvider implements Provider for Google's OAuth 2.0 / OIDC.
type googleProvider struct {
	queries *db.Queries
}

// newGoogleProvider is exported within the package so OAuthHandler
// constructor can register the default Google instance. Other
// providers follow the same constructor shape.
func newGoogleProvider(queries *db.Queries) *googleProvider {
	return &googleProvider{queries: queries}
}

func (p *googleProvider) Name() string { return "google" }

func (p *googleProvider) Config(ctx context.Context) (*oauth2.Config, error) {
	enabled, _ := p.queries.GetSetting(ctx, settingOAuthGoogleEnabled)
	if enabled != "true" {
		return nil, nil
	}
	clientID, _ := p.queries.GetSetting(ctx, settingOAuthGoogleClientID)
	clientSecret, _ := p.queries.GetSetting(ctx, settingOAuthGoogleClientSecret)
	redirectURL, _ := p.queries.GetSetting(ctx, settingOAuthGoogleRedirectURL)
	if clientID == "" || clientSecret == "" || redirectURL == "" {
		return nil, fmt.Errorf("oauth: google client_id, client_secret, and redirect_url must all be set")
	}
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  redirectURL,
		Scopes: []string{
			// "openid" gives us the ID token; "email" and "profile"
			// give us the email + name claims we need to create or
			// link a user.
			"openid",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
		},
		Endpoint: googleoauth.Endpoint,
	}, nil
}

// FetchUserInfo calls Google's OIDC userinfo endpoint and normalizes
// the response into Aurora's OAuthProfile shape.
//
// Google's userinfo returns the `sub` claim (stable subject ID) which
// we use as the OAuth subject. `email_verified` gates Tier-2 auto-
// link; Google is among the few providers that returns this honestly,
// so it can usually be trusted (subject to admin's choice to disable
// the provider if Google ever changes the contract).
func (p *googleProvider) FetchUserInfo(ctx context.Context, client *http.Client) (*OAuthProfile, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://openidconnect.googleapis.com/v1/userinfo", nil)
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
	// Native Google shape — only the subset we consume.
	var raw struct {
		Subject       string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode userinfo: %w", err)
	}
	return &OAuthProfile{
		Subject:       raw.Subject,
		Email:         raw.Email,
		EmailVerified: raw.EmailVerified,
		Name:          raw.Name,
		// Google has no separate handle namespace — leave Username
		// empty so generateUniqueUsername falls back to the email
		// local-part (existing behavior).
		Username:  "",
		AvatarURL: raw.Picture,
	}, nil
}

func (p *googleProvider) BypassInviteEnabled(ctx context.Context) bool {
	v, _ := p.queries.GetSetting(ctx, settingOAuthGoogleBypassInvite)
	return v == "true"
}
