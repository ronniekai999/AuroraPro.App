package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/aurora-media/aurora/internal/db"
	"golang.org/x/oauth2"
)

// Twitch OAuth 2.0 provider.
//
// Twitch uses standard OAuth 2.0 + their Helix API for userinfo.
// Scope `user:read:email` returns the email; without it the helix
// /users response omits the email field entirely.
//
// IMPORTANT — Helix requires a Client-Id header on EVERY request,
// in addition to the bearer token. The oauth2 client only sets the
// Authorization header; Client-Id is set manually in FetchUserInfo.
// Missing this header returns 401 Unauthorized with a misleading
// error message, which is the classic Twitch integration pitfall.
//
// Email verification: Twitch verifies email addresses at account
// creation and doesn't allow API access without verification, so
// `email` from /helix/users can be treated as verified. There is
// no per-user email_verified flag in the response — we hardcode
// EmailVerified=true to enable Tier-2 auto-link. If Twitch ever
// changes this contract (allows API access from unverified accounts),
// this assumption needs revisiting.
//
// Settings keys (parallel to other providers):
//   oauth_twitch_enabled       — "true" or anything else (off)
//   oauth_twitch_client_id     — from dev.twitch.tv app registration
//   oauth_twitch_client_secret — paired secret
//   oauth_twitch_redirect_url  — must match the URI registered on the
//                                 Twitch app (case-sensitive)
//   oauth_twitch_bypass_invite — "true" skips invite requirement

const (
	settingOAuthTwitchEnabled      = "oauth_twitch_enabled"
	settingOAuthTwitchClientID     = "oauth_twitch_client_id"
	settingOAuthTwitchClientSecret = "oauth_twitch_client_secret"
	settingOAuthTwitchRedirectURL  = "oauth_twitch_redirect_url"
	settingOAuthTwitchBypassInvite = "oauth_twitch_bypass_invite"
)

// Twitch isn't in golang.org/x/oauth2/endpoints either (or wasn't at
// time of writing). URLs are stable and documented.
var twitchEndpoint = oauth2.Endpoint{
	AuthURL:   "https://id.twitch.tv/oauth2/authorize",
	TokenURL:  "https://id.twitch.tv/oauth2/token",
	AuthStyle: oauth2.AuthStyleInParams,
}

type twitchProvider struct {
	queries *db.Queries
}

func newTwitchProvider(queries *db.Queries) *twitchProvider {
	return &twitchProvider{queries: queries}
}

func (p *twitchProvider) Name() string { return "twitch" }

func (p *twitchProvider) Config(ctx context.Context) (*oauth2.Config, error) {
	enabled, _ := p.queries.GetSetting(ctx, settingOAuthTwitchEnabled)
	if enabled != "true" {
		return nil, nil
	}
	clientID, _ := p.queries.GetSetting(ctx, settingOAuthTwitchClientID)
	clientSecret, _ := p.queries.GetSetting(ctx, settingOAuthTwitchClientSecret)
	redirectURL, _ := p.queries.GetSetting(ctx, settingOAuthTwitchRedirectURL)
	if clientID == "" || clientSecret == "" || redirectURL == "" {
		return nil, fmt.Errorf("oauth: twitch client_id, client_secret, and redirect_url must all be set")
	}
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  redirectURL,
		Scopes:       []string{"user:read:email"},
		Endpoint:     twitchEndpoint,
	}, nil
}

// FetchUserInfo calls Twitch's Helix /users endpoint and normalizes
// the response. Note the Client-Id header — Helix requires it on top
// of the bearer token, and it's the most common integration mistake.
func (p *twitchProvider) FetchUserInfo(ctx context.Context, client *http.Client) (*OAuthProfile, error) {
	// Client-Id has to come from settings, NOT from the bearer-token's
	// implicit metadata. Re-reads the same setting Config() does — a
	// double DB hit per login, negligible. Keeps Config() and
	// FetchUserInfo() decoupled so neither has to thread state to
	// the other.
	clientID, _ := p.queries.GetSetting(ctx, settingOAuthTwitchClientID)
	if clientID == "" {
		return nil, fmt.Errorf("twitch fetch: client_id missing (configuration drift?)")
	}

	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.twitch.tv/helix/users", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Client-Id", clientID)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("userinfo returned status %d", resp.StatusCode)
	}

	// Helix wraps results in a `data` array even for single-user
	// queries. We always get exactly one entry (the authenticated user).
	var raw struct {
		Data []struct {
			ID              string `json:"id"`
			Login           string `json:"login"`
			DisplayName     string `json:"display_name"`
			ProfileImageURL string `json:"profile_image_url"`
			Email           string `json:"email"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode userinfo: %w", err)
	}
	if len(raw.Data) == 0 {
		return nil, fmt.Errorf("twitch userinfo returned empty data array")
	}
	user := raw.Data[0]

	return &OAuthProfile{
		Subject: user.ID,
		Email:   user.Email,
		// Twitch verifies emails at signup; no per-user flag in the
		// response, so we treat all returned emails as verified.
		// See file header for why this is safe.
		EmailVerified: true,
		Name:          user.DisplayName,
		// `login` is Twitch's lowercase handle — perfect for Aurora's
		// sanitizeUsername (already a-z/0-9/_ shape).
		Username:  user.Login,
		AvatarURL: user.ProfileImageURL,
	}, nil
}

func (p *twitchProvider) BypassInviteEnabled(ctx context.Context) bool {
	v, _ := p.queries.GetSetting(ctx, settingOAuthTwitchBypassInvite)
	return v == "true"
}
