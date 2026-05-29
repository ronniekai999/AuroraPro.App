package api

import "testing"

// TestIsSecretSettingKey is the regression test for audit H7. GET
// /api/admin/settings previously masked only keys ending in "_api_key", which
// silently returned the OAuth client secrets (stored as
// "oauth_*_client_secret") to the client in cleartext. isSecretSettingKey must
// flag every credential-bearing suffix so they are masked.
func TestIsSecretSettingKey(t *testing.T) {
	mustMask := []string{
		"llm_api_key", "radarr_api_key", "sonarr_4k_api_key", "tmdb_api_key",
		"oauth_google_client_secret",   // the H7 leak
		"oauth_discord_client_secret",  // the H7 leak
		"oauth_twitch_client_secret",   // the H7 leak
		"oauth_facebook_client_secret", // the H7 leak
		"oauth_twitter_client_secret",  // the H7 leak
		"smtp_password", "session_token", "vault_credential",
	}
	for _, k := range mustMask {
		if !isSecretSettingKey(k) {
			t.Errorf("isSecretSettingKey(%q) = false; want true (must be masked before serialization)", k)
		}
	}

	mustNotMask := []string{
		"completion_threshold", "max_profiles_per_user", "now_playing_enabled",
		"scan_interval_default", "transcode_max_sessions", "filesystem_watch_enabled",
		"requests_enabled", "radarr_url", "sonarr_4k_url",
		"oauth_google_client_id", // public client id, not a secret
		"oauth_google_enabled",
	}
	for _, k := range mustNotMask {
		if isSecretSettingKey(k) {
			t.Errorf("isSecretSettingKey(%q) = true; want false (non-secret, should display raw)", k)
		}
	}
}
