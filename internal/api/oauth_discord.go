package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/aurora-media/aurora/internal/db"
	"golang.org/x/oauth2"
)

// Discord OAuth 2.0 provider.
//
// Discord uses standard OAuth 2.0 (authorization code flow). Scopes
// `identify` + `email` give us the user ID + display name + email +
// verified flag — everything the three-tier resolution needs.
//
// Avatar URL has to be constructed: Discord returns the avatar as a
// hash string, not a URL. The CDN template is documented at
// https://discord.com/developers/docs/reference#image-formatting.
// When the user has no custom avatar, the hash is empty — we leave
// AvatarURL empty and let Aurora's UI render its default initial
// (instead of falling back to Discord's default-avatar URL pattern,
// which would require modular arithmetic on the snowflake ID).
//
// Email verification: Discord's `verified` field is a boolean —
// trustworthy for Tier-2 auto-link. If the user hasn't verified their
// email on Discord, we conservatively skip the auto-link path (same
// safety property as Google's `email_verified`).
//
// Settings keys (all under server_settings, value column TEXT):
//   oauth_discord_enabled       — "true" or anything else (off)
//   oauth_discord_client_id     — from Discord Developer Portal
//   oauth_discord_client_secret — paired secret
//   oauth_discord_redirect_url  — must match the URI registered on the
//                                 Discord app (case-sensitive,
//                                 trailing-slash-sensitive)
//   oauth_discord_bypass_invite — "true" skips invite requirement
//                                 on NEW user creation via Discord

const (
	settingOAuthDiscordEnabled      = "oauth_discord_enabled"
	settingOAuthDiscordClientID     = "oauth_discord_client_id"
	settingOAuthDiscordClientSecret = "oauth_discord_client_secret"
	settingOAuthDiscordRedirectURL  = "oauth_discord_redirect_url"
	settingOAuthDiscordBypassInvite = "oauth_discord_bypass_invite"
)

// Discord doesn't appear in golang.org/x/oauth2/endpoints, so we
// declare the endpoint inline. URLs are documented + stable.
var discordEndpoint = oauth2.Endpoint{
	AuthURL:   "https://discord.com/api/oauth2/authorize",
	TokenURL:  "https://discord.com/api/oauth2/token",
	AuthStyle: oauth2.AuthStyleInParams,
}

type discordProvider struct {
	queries *db.Queries
}

func newDiscordProvider(queries *db.Queries) *discordProvider {
	return &discordProvider{queries: queries}
}

func (p *discordProvider) Name() string { return "discord" }

func (p *discordProvider) Config(ctx context.Context) (*oauth2.Config, error) {
	enabled, _ := p.queries.GetSetting(ctx, settingOAuthDiscordEnabled)
	if enabled != "true" {
		return nil, nil
	}
	clientID, _ := p.queries.GetSetting(ctx, settingOAuthDiscordClientID)
	clientSecret, _ := p.queries.GetSetting(ctx, settingOAuthDiscordClientSecret)
	redirectURL, _ := p.queries.GetSetting(ctx, settingOAuthDiscordRedirectURL)
	if clientID == "" || clientSecret == "" || redirectURL == "" {
		return nil, fmt.Errorf("oauth: discord client_id, client_secret, and redirect_url must all be set")
	}
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  redirectURL,
		Scopes:       []string{"identify", "email"},
		Endpoint:     discordEndpoint,
	}, nil
}

// FetchUserInfo calls Discord's /users/@me endpoint and normalizes
// the response into OAuthProfile.
func (p *discordProvider) FetchUserInfo(ctx context.Context, client *http.Client) (*OAuthProfile, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://discord.com/api/users/@me", nil)
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
	// Native Discord shape — only the subset we consume.
	// `global_name` is Discord's newer display-name field (post-
	// username-system-migration); `username` is the stable handle.
	// `discriminator` is "0" for migrated users, a 4-digit number
	// for legacy users.
	var raw struct {
		ID            string `json:"id"`
		Username      string `json:"username"`
		Discriminator string `json:"discriminator"`
		GlobalName    string `json:"global_name"`
		Avatar        string `json:"avatar"`
		Email         string `json:"email"`
		Verified      bool   `json:"verified"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode userinfo: %w", err)
	}

	// Build avatar URL from snowflake ID + avatar hash. Discord
	// returns the hash, not a URL — the CDN format is documented.
	// `.png` is universally supported; `.gif` is the alternative for
	// animated avatars (hash starts with "a_") but PNG renders fine
	// for a static UI thumbnail.
	avatarURL := ""
	if raw.Avatar != "" && raw.ID != "" {
		avatarURL = fmt.Sprintf("https://cdn.discordapp.com/avatars/%s/%s.png?size=128", raw.ID, raw.Avatar)
	}

	// Display name preference: global_name (modern) > username
	// (legacy). Stable handle for username-pick is always `username`.
	displayName := raw.GlobalName
	if displayName == "" {
		displayName = raw.Username
	}

	return &OAuthProfile{
		Subject:       raw.ID,
		Email:         raw.Email,
		EmailVerified: raw.Verified,
		Name:          displayName,
		Username:      raw.Username,
		AvatarURL:     avatarURL,
	}, nil
}

func (p *discordProvider) BypassInviteEnabled(ctx context.Context) bool {
	v, _ := p.queries.GetSetting(ctx, settingOAuthDiscordBypassInvite)
	return v == "true"
}
