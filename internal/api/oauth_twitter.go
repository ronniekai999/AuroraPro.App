package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/aurora-media/aurora/internal/db"
	"golang.org/x/oauth2"
)

// X (Twitter) OAuth 2.0 provider (Phase D).
//
// X uses OAuth 2.0 with MANDATORY PKCE (RFC 7636) — token exchanges
// without code_challenge are rejected. We implement PKCEProvider
// so the generic OAuthHandler adds the verifier/challenge
// machinery automatically.
//
// EMAIL CAVEAT — X's free tier does NOT return user email. The
// `email` field requires "Pro tier" plus app review for the
// `users.read` scope's email extension. Aurora's three-tier
// resolver REQUIRES profile.Email to be non-empty (the callback
// validates this and renders a friendly error otherwise).
// To square the circle:
//
//   - FetchUserInfo synthesizes a deterministic placeholder email
//     from the X user ID: `x-{id}@noreply.x.invalid`. This is unique
//     per user (X user IDs are stable), guaranteed-never-routable
//     (`.invalid` is reserved by RFC 6761 — ICANN cannot delegate it),
//     and won't collide with real emails from other providers.
//     Earlier draft used `.aurora` which was a fake TLD vulnerable
//     to future ICANN delegation. Switched to `.invalid` per RFC.
//   - EmailVerified=false: Tier 2 auto-link is intentionally
//     skipped so the synthetic email never accidentally matches a
//     real user's record.
//   - Tier 1 (already-linked) works normally — once a user has
//     signed in with X once, subsequent sign-ins via (provider,
//     subject) lookup succeed without needing the email at all.
//   - Tier 3 (new user creation) works — the synthetic email
//     satisfies the users.email UNIQUE constraint without colliding
//     with real users.
//
// If/when X opens up email access on the free tier, swap the
// synthetic email for the real one and bump EmailVerified to
// match X's signal (X's `verified_email` field will document
// itself).
//
// Brand note: the API is still called Twitter API and the
// endpoints use api.twitter.com/twitter.com domains despite the
// rebrand. We use "twitter" as the internal provider name
// (matches API contract + DB users.oauth_provider rows) and "X"
// as the user-facing label in the AuthView button.
//
// Settings keys (parallel to other providers):
//   oauth_twitter_enabled       — "true" or anything else (off)
//   oauth_twitter_client_id     — from developer.twitter.com app
//   oauth_twitter_client_secret — paired secret
//   oauth_twitter_redirect_url  — must match registered URI
//   oauth_twitter_bypass_invite — "true" skips invite requirement

const (
	settingOAuthTwitterEnabled      = "oauth_twitter_enabled"
	settingOAuthTwitterClientID     = "oauth_twitter_client_id"
	settingOAuthTwitterClientSecret = "oauth_twitter_client_secret"
	settingOAuthTwitterRedirectURL  = "oauth_twitter_redirect_url"
	settingOAuthTwitterBypassInvite = "oauth_twitter_bypass_invite"
)

// X's OAuth 2.0 endpoints. URLs still use the twitter.com domain
// even after the rebrand — X's API contract is stable on this.
//
// AuthStyle omitted (= AuthStyleAutoDetect): X supports two app
// modes — "Confidential client" (uses HTTP Basic auth header with
// client_id:client_secret on token exchange) and "Public client"
// (no secret; PKCE verifier is the proof). AutoDetect lets the
// oauth2 library try Basic-header first and fall back to params,
// so the same provider config works for either app type the admin
// registered on X's developer portal. With a missing ClientSecret
// the lib also auto-handles it (sends client_id in form params,
// no Basic auth attempted) — the right shape for public clients.
var twitterEndpoint = oauth2.Endpoint{
	AuthURL:  "https://twitter.com/i/oauth2/authorize",
	TokenURL: "https://api.twitter.com/2/oauth2/token",
}

type twitterProvider struct {
	queries *db.Queries
}

func newTwitterProvider(queries *db.Queries) *twitterProvider {
	return &twitterProvider{queries: queries}
}

func (p *twitterProvider) Name() string { return "twitter" }

// WantsPKCE — implements PKCEProvider. X mandates PKCE; the
// generic handler will generate a verifier + challenge for us.
func (p *twitterProvider) WantsPKCE() bool { return true }

func (p *twitterProvider) Config(ctx context.Context) (*oauth2.Config, error) {
	enabled, _ := p.queries.GetSetting(ctx, settingOAuthTwitterEnabled)
	if enabled != "true" {
		return nil, nil
	}
	clientID, _ := p.queries.GetSetting(ctx, settingOAuthTwitterClientID)
	clientSecret, _ := p.queries.GetSetting(ctx, settingOAuthTwitterClientSecret)
	redirectURL, _ := p.queries.GetSetting(ctx, settingOAuthTwitterRedirectURL)
	// Audit H1 — client_secret is OPTIONAL for X.
	// X's developer portal lets admins register either a "Confidential
	// client" (with secret, uses Basic auth on token exchange) or a
	// "Public client" (no secret, PKCE verifier is the proof). Both
	// flows are valid OAuth 2.0 + PKCE. We only require client_id
	// and redirect_url here; if the admin left secret empty, the
	// oauth2 library handles it correctly (no Basic auth attempt).
	if clientID == "" || redirectURL == "" {
		return nil, fmt.Errorf("oauth: twitter client_id and redirect_url must be set")
	}
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret, // may be "" for public-client mode
		RedirectURL:  redirectURL,
		// `tweet.read` is the minimum to make `users.read` work;
		// `users.read` returns the basic profile from /users/me;
		// `offline.access` would give us a refresh token, which we
		// don't actually use (Aurora stores its own JWT after
		// sign-in), so we omit it.
		Scopes:   []string{"tweet.read", "users.read"},
		Endpoint: twitterEndpoint,
	}, nil
}

// FetchUserInfo calls X's /2/users/me endpoint and normalizes the
// response. Synthesizes a placeholder email — see file header for
// rationale.
func (p *twitterProvider) FetchUserInfo(ctx context.Context, client *http.Client) (*OAuthProfile, error) {
	// `user.fields=profile_image_url` requests the avatar URL,
	// which isn't in the default projection.
	req, err := http.NewRequestWithContext(ctx, "GET",
		"https://api.twitter.com/2/users/me?user.fields=profile_image_url", nil)
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
	// X wraps the user in a `data` object. The free-tier projection
	// doesn't include email.
	var raw struct {
		Data struct {
			ID              string `json:"id"`
			Name            string `json:"name"`
			Username        string `json:"username"`
			ProfileImageURL string `json:"profile_image_url"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode userinfo: %w", err)
	}
	if raw.Data.ID == "" {
		return nil, fmt.Errorf("twitter userinfo: empty user ID in response")
	}

	// Synthesize a placeholder email. See file header for rationale
	// — guarantees uniqueness per X user, never collides with real
	// emails (`.invalid` is RFC 6761-reserved and never delegated),
	// and Tier 2 auto-link is correctly skipped because
	// EmailVerified=false.
	syntheticEmail := fmt.Sprintf("x-%s@noreply.x.invalid", raw.Data.ID)

	return &OAuthProfile{
		Subject:       raw.Data.ID,
		Email:         syntheticEmail,
		EmailVerified: false, // synthetic — must NOT enable Tier 2
		Name:          raw.Data.Name,
		Username:      raw.Data.Username, // X's stable handle (lowercased by sanitizeUsername)
		AvatarURL:     raw.Data.ProfileImageURL,
	}, nil
}

func (p *twitterProvider) BypassInviteEnabled(ctx context.Context) bool {
	v, _ := p.queries.GetSetting(ctx, settingOAuthTwitterBypassInvite)
	return v == "true"
}
