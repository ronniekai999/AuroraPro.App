package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDefaults(t *testing.T) {
	// Load with required env vars set to pass validation
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TMDB_API_KEY", "fake-tmdb-key-for-testing")
	// Prevent picking up any real config file
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	// Server defaults
	if cfg.Server.Host != "0.0.0.0" {
		t.Errorf("Server.Host = %q, want %q", cfg.Server.Host, "0.0.0.0")
	}
	if cfg.Server.Port != 8484 {
		t.Errorf("Server.Port = %d, want %d", cfg.Server.Port, 8484)
	}

	// Database defaults
	if cfg.Database.MaxConns != 10 {
		t.Errorf("Database.MaxConns = %d, want %d", cfg.Database.MaxConns, 10)
	}
	if cfg.Database.MinConns != 2 {
		t.Errorf("Database.MinConns = %d, want %d", cfg.Database.MinConns, 2)
	}

	// Auth defaults
	if cfg.Auth.AccessTokenExpiry != 15*time.Minute {
		t.Errorf("Auth.AccessTokenExpiry = %v, want %v", cfg.Auth.AccessTokenExpiry, 15*time.Minute)
	}
	if cfg.Auth.RefreshTokenExpiry != 30*24*time.Hour {
		t.Errorf("Auth.RefreshTokenExpiry = %v, want %v", cfg.Auth.RefreshTokenExpiry, 30*24*time.Hour)
	}
	if cfg.Auth.Argon2Memory != 64*1024 {
		t.Errorf("Auth.Argon2Memory = %d, want %d", cfg.Auth.Argon2Memory, 64*1024)
	}
	if cfg.Auth.InviteCodeLength != 16 {
		t.Errorf("Auth.InviteCodeLength = %d, want %d", cfg.Auth.InviteCodeLength, 16)
	}

	// Scanner defaults
	if cfg.Scanner.Workers != 8 {
		t.Errorf("Scanner.Workers = %d, want %d", cfg.Scanner.Workers, 8)
	}
	if cfg.Scanner.FFprobePath != "ffprobe" {
		t.Errorf("Scanner.FFprobePath = %q, want %q", cfg.Scanner.FFprobePath, "ffprobe")
	}

	// TMDB defaults
	if cfg.TMDB.Language != "en" {
		t.Errorf("TMDB.Language = %q, want %q", cfg.TMDB.Language, "en")
	}

	// Transcode defaults
	if cfg.Transcode.HWAccel != "auto" {
		t.Errorf("Transcode.HWAccel = %q, want %q", cfg.Transcode.HWAccel, "auto")
	}
	if cfg.Transcode.SegmentDuration != 6 {
		t.Errorf("Transcode.SegmentDuration = %d, want %d", cfg.Transcode.SegmentDuration, 6)
	}
	// The default must be the policy that reproduces the historical encoder
	// arguments — an upgrade that silently re-tuned every transcode would be
	// exactly the regression this knob is designed to avoid.
	if cfg.Transcode.QualityPolicy != "balanced" {
		t.Errorf("Transcode.QualityPolicy = %q, want %q", cfg.Transcode.QualityPolicy, "balanced")
	}
	if cfg.Transcode.SessionTimeout != 300*time.Second {
		t.Errorf("Transcode.SessionTimeout = %v, want %v", cfg.Transcode.SessionTimeout, 300*time.Second)
	}
}

func TestEnvOverrides(t *testing.T) {
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TMDB_API_KEY", "fake-tmdb-key-for-testing")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")

	// Set overrides
	t.Setenv("AURORA_HOST", "127.0.0.1")
	t.Setenv("AURORA_PORT", "9090")
	t.Setenv("DATABASE_URL", "postgres://test:test@db:5432/test")
	t.Setenv("DB_MAX_CONNS", "20")
	t.Setenv("DB_MIN_CONNS", "5")
	t.Setenv("ACCESS_TOKEN_MINUTES", "30")
	t.Setenv("REFRESH_TOKEN_DAYS", "14")
	t.Setenv("SCANNER_WORKERS", "4")
	t.Setenv("FFPROBE_PATH", "/usr/bin/ffprobe")
	t.Setenv("WATCH_DEBOUNCE_MS", "5000")
	t.Setenv("METADATA_REFRESH_HOURS", "48")
	t.Setenv("TMDB_LANGUAGE", "de")
	t.Setenv("TRANSCODE_MAX_SESSIONS", "5")
	t.Setenv("TRANSCODE_HW_ACCEL", "nvenc")
	t.Setenv("TRANSCODE_SESSION_TIMEOUT_SEC", "300")
	t.Setenv("TRANSCODE_SEGMENT_DURATION", "10")
	t.Setenv("TRANSCODE_PROFILES", "1080p,720p")
	t.Setenv("CACHE_IMAGE_DIR", "/custom/images")
	t.Setenv("CACHE_TRANSCODE_DIR", "/custom/transcode")
	t.Setenv("CACHE_SUBTITLE_DIR", "/custom/subtitles")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	if cfg.Server.Host != "127.0.0.1" {
		t.Errorf("Server.Host = %q, want %q", cfg.Server.Host, "127.0.0.1")
	}
	if cfg.Server.Port != 9090 {
		t.Errorf("Server.Port = %d, want %d", cfg.Server.Port, 9090)
	}
	if cfg.Database.URL != "postgres://test:test@db:5432/test" {
		t.Errorf("Database.URL = %q, want postgres URL", cfg.Database.URL)
	}
	if cfg.Database.MaxConns != 20 {
		t.Errorf("Database.MaxConns = %d, want %d", cfg.Database.MaxConns, 20)
	}
	if cfg.Database.MinConns != 5 {
		t.Errorf("Database.MinConns = %d, want %d", cfg.Database.MinConns, 5)
	}
	if cfg.Auth.AccessTokenExpiry != 30*time.Minute {
		t.Errorf("Auth.AccessTokenExpiry = %v, want %v", cfg.Auth.AccessTokenExpiry, 30*time.Minute)
	}
	if cfg.Auth.RefreshTokenExpiry != 14*24*time.Hour {
		t.Errorf("Auth.RefreshTokenExpiry = %v, want %v", cfg.Auth.RefreshTokenExpiry, 14*24*time.Hour)
	}
	if cfg.Scanner.Workers != 4 {
		t.Errorf("Scanner.Workers = %d, want %d", cfg.Scanner.Workers, 4)
	}
	if cfg.Scanner.FFprobePath != "/usr/bin/ffprobe" {
		t.Errorf("Scanner.FFprobePath = %q, want %q", cfg.Scanner.FFprobePath, "/usr/bin/ffprobe")
	}
	if cfg.Scanner.WatchDebounce != 5000*time.Millisecond {
		t.Errorf("Scanner.WatchDebounce = %v, want %v", cfg.Scanner.WatchDebounce, 5000*time.Millisecond)
	}
	if cfg.TMDB.MetadataRefresh != 48*time.Hour {
		t.Errorf("TMDB.MetadataRefresh = %v, want %v", cfg.TMDB.MetadataRefresh, 48*time.Hour)
	}
	if cfg.TMDB.Language != "de" {
		t.Errorf("TMDB.Language = %q, want %q", cfg.TMDB.Language, "de")
	}
	if cfg.Transcode.MaxSessions != 5 {
		t.Errorf("Transcode.MaxSessions = %d, want %d", cfg.Transcode.MaxSessions, 5)
	}
	if cfg.Transcode.HWAccel != "nvenc" {
		t.Errorf("Transcode.HWAccel = %q, want %q", cfg.Transcode.HWAccel, "nvenc")
	}
	if cfg.Transcode.SessionTimeout != 300*time.Second {
		t.Errorf("Transcode.SessionTimeout = %v, want %v", cfg.Transcode.SessionTimeout, 300*time.Second)
	}
	if cfg.Transcode.SegmentDuration != 10 {
		t.Errorf("Transcode.SegmentDuration = %d, want %d", cfg.Transcode.SegmentDuration, 10)
	}
	if len(cfg.Transcode.Profiles) != 2 || cfg.Transcode.Profiles[0] != "1080p" || cfg.Transcode.Profiles[1] != "720p" {
		t.Errorf("Transcode.Profiles = %v, want [1080p, 720p]", cfg.Transcode.Profiles)
	}
	if cfg.Cache.ImageDir != "/custom/images" {
		t.Errorf("Cache.ImageDir = %q, want %q", cfg.Cache.ImageDir, "/custom/images")
	}
	if cfg.Cache.TranscodeDir != "/custom/transcode" {
		t.Errorf("Cache.TranscodeDir = %q, want %q", cfg.Cache.TranscodeDir, "/custom/transcode")
	}
	if cfg.Cache.SubtitleDir != "/custom/subtitles" {
		t.Errorf("Cache.SubtitleDir = %q, want %q", cfg.Cache.SubtitleDir, "/custom/subtitles")
	}
}

func TestLoad_MissingJWTSecret(t *testing.T) {
	t.Setenv("JWT_SECRET", "")
	t.Setenv("TMDB_API_KEY", "fake-key")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")

	_, err := Load()
	if err == nil {
		t.Error("Load() should error when JWT_SECRET is missing")
	}
}

func TestLoad_ShortJWTSecret(t *testing.T) {
	t.Setenv("JWT_SECRET", "too-short")
	t.Setenv("TMDB_API_KEY", "fake-key")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")

	_, err := Load()
	if err == nil {
		t.Error("Load() should error when JWT_SECRET is too short")
	}
}

func TestLoad_PlaceholderJWTSecret(t *testing.T) {
	t.Setenv("JWT_SECRET", "change-me-to-a-random-64-char-string-in-production")
	t.Setenv("TMDB_API_KEY", "fake-key")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")

	_, err := Load()
	if err == nil {
		t.Error("Load() should error when JWT_SECRET is a known placeholder")
	}
}

// With no TMDB_API_KEY in the environment, Load must fall back to the
// bundled application key (2026-07-18) instead of erroring — this is
// what makes fresh installs work with zero signup. The bundled TVDB
// project key likewise auto-enables the TVDB fallback.
func TestLoad_MissingTMDBKeyUsesBundledDefaults(t *testing.T) {
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TMDB_API_KEY", "")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() should succeed via the bundled TMDB key, got error: %v", err)
	}
	if cfg.TMDB.APIKey == "" {
		t.Error("TMDB.APIKey should be the bundled default when TMDB_API_KEY is unset")
	}
	if cfg.TVDB.APIKey == "" || !cfg.TVDB.Enabled {
		t.Errorf("bundled TVDB key should auto-enable the fallback (key=%q enabled=%v)", cfg.TVDB.APIKey, cfg.TVDB.Enabled)
	}
}

// An explicit TMDB_API_KEY must still override the bundled default.
func TestLoad_ExplicitTMDBKeyOverridesBundled(t *testing.T) {
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TMDB_API_KEY", "my-own-key")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if cfg.TMDB.APIKey != "my-own-key" {
		t.Errorf("TMDB.APIKey = %q, want the explicit override", cfg.TMDB.APIKey)
	}
}

// TVDB_ENABLED=false must opt out of the auto-enabled bundled fallback.
func TestLoad_TVDBExplicitDisableWinsOverBundledKey(t *testing.T) {
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TVDB_ENABLED", "false")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if cfg.TVDB.Enabled {
		t.Error("TVDB.Enabled should be false when TVDB_ENABLED=false, even with the bundled key present")
	}
}

func TestServerAddr(t *testing.T) {
	cfg := &Config{
		Server: ServerConfig{Host: "0.0.0.0", Port: 8484},
	}
	got := cfg.ServerAddr()
	want := "0.0.0.0:8484"
	if got != want {
		t.Errorf("ServerAddr() = %q, want %q", got, want)
	}
}

func TestOriginAllowed(t *testing.T) {
	cfg := &Config{
		Server: ServerConfig{
			AllowedOrigins: []string{"http://localhost:*", "https://example.com"},
		},
	}

	tests := []struct {
		name   string
		origin string
		want   bool
	}{
		{name: "localhost with port", origin: "http://localhost:3000", want: true},
		{name: "localhost with another port", origin: "http://localhost:8080", want: true},
		{name: "exact match", origin: "https://example.com", want: true},
		{name: "not allowed", origin: "https://evil.com", want: false},
		{name: "empty origin", origin: "", want: false},
		{name: "wildcard suffix abuse", origin: "http://localhost:evil.com", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cfg.OriginAllowed(tt.origin)
			if got != tt.want {
				t.Errorf("OriginAllowed(%q) = %v, want %v", tt.origin, got, tt.want)
			}
		})
	}
}

func TestOriginAllowed_Wildcard(t *testing.T) {
	cfg := &Config{
		Server: ServerConfig{AllowedOrigins: []string{"*"}},
	}

	if !cfg.OriginAllowed("https://anything.com") {
		t.Error("wildcard * should allow any origin")
	}
}

func TestParseOrigins(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  int
	}{
		{name: "comma separated", input: "http://a.com,http://b.com", want: 2},
		{name: "with spaces", input: " http://a.com , http://b.com ", want: 2},
		{name: "empty", input: "", want: 0},
		{name: "single", input: "http://localhost:3000", want: 1},
		{name: "trailing comma", input: "http://a.com,", want: 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseOrigins(tt.input)
			if len(got) != tt.want {
				t.Errorf("parseOrigins(%q) returned %d items, want %d", tt.input, len(got), tt.want)
			}
		})
	}
}

func TestSplitCSV(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []string
	}{
		{name: "basic", input: "a,b,c", want: []string{"a", "b", "c"}},
		{name: "with spaces", input: " a , b , c ", want: []string{"a", "b", "c"}},
		{name: "empty", input: "", want: nil},
		{name: "trailing comma", input: "a,b,", want: []string{"a", "b"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitCSV(tt.input)
			if tt.want == nil {
				if got != nil {
					t.Errorf("splitCSV(%q) = %v, want nil", tt.input, got)
				}
				return
			}
			if len(got) != len(tt.want) {
				t.Fatalf("splitCSV(%q) len = %d, want %d", tt.input, len(got), len(tt.want))
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("splitCSV(%q)[%d] = %q, want %q", tt.input, i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestTLSEnvOverrides(t *testing.T) {
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TMDB_API_KEY", "fake-tmdb-key-for-testing")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")
	t.Setenv("TLS_ENABLED", "true")
	t.Setenv("TLS_CERT_FILE", "/path/to/cert.pem")
	t.Setenv("TLS_KEY_FILE", "/path/to/key.pem")
	t.Setenv("TLS_AUTO_CERT", "true")
	t.Setenv("TLS_DOMAIN", "media.example.com")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	if !cfg.TLS.Enabled {
		t.Error("TLS.Enabled = false, want true")
	}
	if cfg.TLS.CertFile != "/path/to/cert.pem" {
		t.Errorf("TLS.CertFile = %q, want %q", cfg.TLS.CertFile, "/path/to/cert.pem")
	}
	if cfg.TLS.KeyFile != "/path/to/key.pem" {
		t.Errorf("TLS.KeyFile = %q, want %q", cfg.TLS.KeyFile, "/path/to/key.pem")
	}
	if !cfg.TLS.AutoCert {
		t.Error("TLS.AutoCert = false, want true")
	}
	if cfg.TLS.Domain != "media.example.com" {
		t.Errorf("TLS.Domain = %q, want %q", cfg.TLS.Domain, "media.example.com")
	}
}

func TestTVDB_AutoEnable(t *testing.T) {
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TMDB_API_KEY", "fake-tmdb-key-for-testing")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")
	t.Setenv("TVDB_API_KEY", "some-tvdb-key")
	// Do NOT set TVDB_ENABLED, it should auto-enable

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	if !cfg.TVDB.Enabled {
		t.Error("TVDB.Enabled should be auto-enabled when API key is set")
	}
}

func TestTVDB_ExplicitDisable(t *testing.T) {
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TMDB_API_KEY", "fake-tmdb-key-for-testing")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")
	t.Setenv("TVDB_API_KEY", "some-tvdb-key")
	t.Setenv("TVDB_ENABLED", "false")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	if cfg.TVDB.Enabled {
		t.Error("TVDB.Enabled should be false when explicitly disabled")
	}
}

func TestYAMLLoading(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `
server:
  host: "192.168.1.100"
  port: 9999
  allowed_origins:
    - "https://custom.example.com"
database:
  url: "postgres://yaml:yaml@db:5432/yamldb"
  max_conns: 50
auth:
  jwt_secret: "yaml-jwt-secret-that-is-long-enough-for-validation-1234567890"
  access_token_minutes: 60
  refresh_token_days: 7
scanner:
  workers: 16
  ffprobe_path: "/opt/ffmpeg/ffprobe"
tmdb:
  api_key: "yaml-tmdb-key"
  language: "ja"
transcode:
  max_sessions: 10
  hw_accel: "qsv"
  quality_policy: "quality"
  session_timeout_sec: 600
  segment_duration: 4
  profiles:
    - "720p"
    - "480p"
`
	yamlPath := filepath.Join(dir, "aurora.yaml")
	if err := os.WriteFile(yamlPath, []byte(yamlContent), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("AURORA_CONFIG_FILE", yamlPath)
	// Clear env overrides so YAML values take effect
	t.Setenv("JWT_SECRET", "")
	t.Setenv("TMDB_API_KEY", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	if cfg.Server.Host != "192.168.1.100" {
		t.Errorf("Server.Host = %q, want %q", cfg.Server.Host, "192.168.1.100")
	}
	if cfg.Server.Port != 9999 {
		t.Errorf("Server.Port = %d, want %d", cfg.Server.Port, 9999)
	}
	if cfg.Database.MaxConns != 50 {
		t.Errorf("Database.MaxConns = %d, want %d", cfg.Database.MaxConns, 50)
	}
	if cfg.Scanner.Workers != 16 {
		t.Errorf("Scanner.Workers = %d, want %d", cfg.Scanner.Workers, 16)
	}
	if cfg.TMDB.Language != "ja" {
		t.Errorf("TMDB.Language = %q, want %q", cfg.TMDB.Language, "ja")
	}
	if cfg.Transcode.MaxSessions != 10 {
		t.Errorf("Transcode.MaxSessions = %d, want %d", cfg.Transcode.MaxSessions, 10)
	}
	if cfg.Transcode.SegmentDuration != 4 {
		t.Errorf("Transcode.SegmentDuration = %d, want %d", cfg.Transcode.SegmentDuration, 4)
	}
	if cfg.Transcode.QualityPolicy != "quality" {
		t.Errorf("Transcode.QualityPolicy = %q, want %q", cfg.Transcode.QualityPolicy, "quality")
	}
	if cfg.Auth.AccessTokenExpiry != 60*time.Minute {
		t.Errorf("Auth.AccessTokenExpiry = %v, want %v", cfg.Auth.AccessTokenExpiry, 60*time.Minute)
	}
}

// TestTranscodeDeliveryKnobs pins the September 2026 playback knobs through
// every surface they can be set from — defaults, YAML keys, env overrides —
// so a knob that parses on one surface and is silently dropped on another
// cannot ship (the quality policy shipped exactly that way once).
func TestTranscodeDeliveryKnobs(t *testing.T) {
	setRequired := func(t *testing.T) {
		t.Helper()
		t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
		t.Setenv("TMDB_API_KEY", "fake-tmdb-key-for-testing")
		t.Setenv("TRANSCODE_STEREO_DOWNMIX", "")
		t.Setenv("TRANSCODE_HEVC_OUTPUT", "")
	}

	t.Run("defaults", func(t *testing.T) {
		setRequired(t)
		t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() error: %v", err)
		}
		if cfg.Transcode.StereoDownmix != "standard" {
			t.Errorf("Transcode.StereoDownmix default = %q, want standard", cfg.Transcode.StereoDownmix)
		}
		if cfg.Transcode.HEVCOutput != "auto" {
			t.Errorf("Transcode.HEVCOutput default = %q, want auto", cfg.Transcode.HEVCOutput)
		}
	})

	t.Run("yaml", func(t *testing.T) {
		setRequired(t)
		dir := t.TempDir()
		yamlPath := filepath.Join(dir, "aurora.yaml")
		body := "transcode:\n  stereo_downmix: \"night\"\n  hevc_output: \"all\"\n"
		if err := os.WriteFile(yamlPath, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("AURORA_CONFIG_FILE", yamlPath)
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() error: %v", err)
		}
		if cfg.Transcode.StereoDownmix != "night" {
			t.Errorf("yaml stereo_downmix = %q, want night", cfg.Transcode.StereoDownmix)
		}
		if cfg.Transcode.HEVCOutput != "all" {
			t.Errorf("yaml hevc_output = %q, want all", cfg.Transcode.HEVCOutput)
		}
	})

	t.Run("env overrides yaml", func(t *testing.T) {
		setRequired(t)
		dir := t.TempDir()
		yamlPath := filepath.Join(dir, "aurora.yaml")
		body := "transcode:\n  stereo_downmix: \"night\"\n  hevc_output: \"all\"\n"
		if err := os.WriteFile(yamlPath, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("AURORA_CONFIG_FILE", yamlPath)
		t.Setenv("TRANSCODE_STEREO_DOWNMIX", "dialogue")
		t.Setenv("TRANSCODE_HEVC_OUTPUT", "off")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() error: %v", err)
		}
		if cfg.Transcode.StereoDownmix != "dialogue" {
			t.Errorf("env stereo_downmix = %q, want dialogue", cfg.Transcode.StereoDownmix)
		}
		if cfg.Transcode.HEVCOutput != "off" {
			t.Errorf("env hevc_output = %q, want off", cfg.Transcode.HEVCOutput)
		}
	})
}

func TestAllowedOrigins_Override(t *testing.T) {
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TMDB_API_KEY", "fake-tmdb-key-for-testing")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")
	t.Setenv("AURORA_ALLOWED_ORIGINS", "https://app.example.com,https://admin.example.com")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	if len(cfg.Server.AllowedOrigins) != 2 {
		t.Fatalf("AllowedOrigins count = %d, want 2", len(cfg.Server.AllowedOrigins))
	}
	if cfg.Server.AllowedOrigins[0] != "https://app.example.com" {
		t.Errorf("AllowedOrigins[0] = %q", cfg.Server.AllowedOrigins[0])
	}
	if cfg.Server.AllowedOrigins[1] != "https://admin.example.com" {
		t.Errorf("AllowedOrigins[1] = %q", cfg.Server.AllowedOrigins[1])
	}
}

// A wildcard origin combined with credentialed CORS is the footgun guarded
// by Config.Validate: go-chi reflects ACAO:* + credentials:true, which every
// browser rejects, silently breaking cookie/OAuth login. Load must fail fast.
func TestAllowedOrigins_WildcardWithCredentials_FailsFast(t *testing.T) {
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TMDB_API_KEY", "fake-tmdb-key-for-testing")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")
	t.Setenv("AURORA_ALLOWED_ORIGINS", "*")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() with AURORA_ALLOWED_ORIGINS=* should fail, got nil error")
	}
	if !strings.Contains(err.Error(), "AURORA_ALLOWED_ORIGINS=*") {
		t.Errorf("error = %q, want it to mention AURORA_ALLOWED_ORIGINS=*", err.Error())
	}
}

// A wildcard mixed in with explicit origins is just as broken — the loop must
// catch "*" anywhere in the list, not only when it's the sole entry.
func TestAllowedOrigins_WildcardAmongExplicit_FailsFast(t *testing.T) {
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TMDB_API_KEY", "fake-tmdb-key-for-testing")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")
	t.Setenv("AURORA_ALLOWED_ORIGINS", "https://app.example.com,*")

	if _, err := Load(); err == nil {
		t.Fatal("Load() with a wildcard among explicit origins should fail, got nil error")
	}
}

// The default localhost:* port-wildcard (and any explicit scheme+host[:port]
// origin) must keep working — only the bare "*" allow-all sentinel is refused.
func TestValidate_PortWildcardAndExplicitOK(t *testing.T) {
	cases := []struct {
		name    string
		origins []string
	}{
		{"default localhost", parseOrigins("http://localhost:*,https://localhost:*")},
		{"explicit hosts", []string{"https://aurora.example.com", "https://admin.example.com"}},
		{"empty list", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Config{Server: ServerConfig{AllowedOrigins: tc.origins}}
			if err := c.Validate(); err != nil {
				t.Errorf("Validate() with %v = %v, want nil", tc.origins, err)
			}
		})
	}
}

// The value that produced this test filed months of GitHub issues whose
// attachment link was dead, and logged nothing at all while doing it:
//
//	BUG_REPORT_PUBLIC_BASE_URL=https://aurorapro.app   # no trailing slash
//
// systemd's EnvironmentFile= has no inline-comment support, so the whole
// string after the `=` reached the process and was concatenated straight into
// the issue body. The old normalization was TrimRight(v, "/"), a no-op here,
// and the startup checks only looked at the scheme prefix — which this value
// has — so it took the happy path in silence.
//
// The shell disagrees, which is what hid it: scripts/aurora-update.sh sources
// the same file with `set -a; . file`, so an operator debugging by sourcing
// saw a clean value.
func TestBugReportPublicBaseURL_Sanitizes(t *testing.T) {
	tests := []struct {
		name string
		env  string
		want string
	}{
		{
			// The exact production value from issue #503.
			name: "inline comment systemd would have kept",
			env:  "https://aurorapro.app   # no trailing slash",
			want: "https://aurorapro.app",
		},
		{
			name: "tab-preceded comment",
			env:  "https://aurora.example.com\t# note",
			want: "https://aurora.example.com",
		},
		{
			name: "comment plus the trailing slash it warns about",
			env:  "https://aurora.example.com/  # no trailing slash",
			want: "https://aurora.example.com",
		},
		{
			name: "trailing spaces alone",
			env:  "https://aurora.example.com   ",
			want: "https://aurora.example.com",
		},
		{
			name: "leading spaces alone",
			env:  "   https://aurora.example.com",
			want: "https://aurora.example.com",
		},
		{
			name: "trailing slash alone — the original rule still applies",
			env:  "https://aurora.example.com/",
			want: "https://aurora.example.com",
		},
		{
			name: "several trailing slashes",
			env:  "https://aurora.example.com///",
			want: "https://aurora.example.com",
		},
		{
			// A `#` NOT preceded by whitespace is part of the value. Cutting
			// at every `#` would silently truncate a legitimate URL, which is
			// a worse failure than the one being fixed: it would break a
			// working config rather than repair a broken one.
			name: "bare # inside the value survives",
			env:  "https://aurora.example.com/base#frag",
			want: "https://aurora.example.com/base#frag",
		},
		{
			name: "# immediately after the host survives",
			env:  "https://aurora.example.com#anchor",
			want: "https://aurora.example.com#anchor",
		},
		{
			name: "a path is preserved, only the trailing slash goes",
			env:  "https://aurora.example.com/aurora/",
			want: "https://aurora.example.com/aurora",
		},
		{
			// The `i == 0` / no-previous-rune guard. Without it the cut
			// indexes before the start of the string and Load() panics, so the
			// server never boots.
			name: "value that is entirely a comment does not panic",
			env:  "#disabled",
			want: "#disabled",
		},
		{
			name: "clean value is untouched",
			env:  "https://aurora.example.com",
			want: "https://aurora.example.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
			t.Setenv("TMDB_API_KEY", "fake-tmdb-key-for-testing")
			t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")
			t.Setenv("BUG_REPORT_PUBLIC_BASE_URL", tt.env)

			cfg, err := Load()
			if err != nil {
				t.Fatalf("Load() error: %v", err)
			}
			if got := cfg.BugReport.PublicBaseURL; got != tt.want {
				t.Errorf("PublicBaseURL = %q, want %q (from env %q)", got, tt.want, tt.env)
			}
			// The point of the whole exercise: the URL this config composes
			// must be one GitHub's image proxy can actually fetch.
			attachment := cfg.BugReport.PublicBaseURL + "/api/feedback/attachments/x.png"
			if strings.ContainsAny(attachment, " \t") {
				t.Errorf("composed attachment URL contains whitespace: %q", attachment)
			}
		})
	}
}

// The token and repo take the same route through systemd and fail the same
// way, with a symptom that names nothing: an opaque 401 or 404 from GitHub.
func TestBugReportGitHubCredentials_Trimmed(t *testing.T) {
	t.Setenv("JWT_SECRET", "a-valid-jwt-secret-that-is-at-least-32-characters-long-12345678")
	t.Setenv("TMDB_API_KEY", "fake-tmdb-key-for-testing")
	t.Setenv("AURORA_CONFIG_FILE", "/nonexistent/aurora.yaml")
	t.Setenv("BUG_REPORT_GITHUB_TOKEN", "  ghp_exampletoken  ")
	t.Setenv("BUG_REPORT_GITHUB_REPO", "  owner/repo  ")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if got := cfg.BugReport.GitHubToken; got != "ghp_exampletoken" {
		t.Errorf("GitHubToken = %q, want it trimmed", got)
	}
	if got := cfg.BugReport.GitHubRepo; got != "owner/repo" {
		t.Errorf("GitHubRepo = %q, want it trimmed", got)
	}
}

// The acceptance criterion is about the COMPOSITION: a value that is still
// unusable after cleaning has to be surfaced. Testing baseURLComplaint alone
// cannot show that, because the inputs that motivated it no longer survive the
// clean — so this drives both together, the way applyEnvOverrides does.
func TestCleanThenComplain(t *testing.T) {
	quiet := []string{
		// The production value: cleaned successfully, so no complaint. The
		// operator still hears about it — via the cut-comment WARN, not here.
		"https://aurorapro.app   # no trailing slash",
		"https://aurora.example.com",
		"https://aurora.example.com/aurora/",
		"   https://aurora.example.com   ",
	}
	for _, in := range quiet {
		cleaned, _ := cleanBaseURL(in)
		if c := baseURLComplaint(cleaned); c != "" {
			t.Errorf("cleanBaseURL(%q) = %q, then complained %q; want no complaint", in, cleaned, c)
		}
	}

	loud := []string{
		// A `#` with no whitespace before it is not a comment, so it survives
		// the clean — and a fragment on a BASE url silently swallows the
		// attachment path, which is the very failure being fixed.
		"https://aurora.example.com/base#frag",
		"https://aurora.example.com/base?a=1",
		// Whitespace the comment cut cannot explain away.
		"https://aurora example.com",
		"aurora.example.com",
		"/api/feedback",
		// A non-breaking space — how a value pasted from a browser or a
		// rendered doc arrives. Neither the cut nor a " \t" check sees it.
		"https://aurora.example.com /x",
	}
	for _, in := range loud {
		cleaned, _ := cleanBaseURL(in)
		if baseURLComplaint(cleaned) == "" {
			t.Errorf("cleanBaseURL(%q) = %q, then no complaint; want one", in, cleaned)
		}
	}
}

// The cut-comment signal is what stops this fix from silently masking a broken
// env file forever, so it is pinned rather than left to the log.
func TestCleanBaseURLReportsTheCut(t *testing.T) {
	cut := []string{
		"https://aurorapro.app   # no trailing slash",
		"https://aurora.example.com\t# note",
		"https://aurora.example.com # nbsp-preceded",
	}
	for _, in := range cut {
		if _, didCut := cleanBaseURL(in); !didCut {
			t.Errorf("cleanBaseURL(%q) did not report cutting a comment", in)
		}
	}

	// Nothing was removed that the operator needs to hear about: a bare `#`
	// belongs to the value, and trailing space or slash is not a misconfig.
	kept := []string{
		"https://aurora.example.com#frag",
		"https://aurora.example.com/a#b",
		"#disabled",
		"https://aurora.example.com/  ",
		"https://aurora.example.com",
	}
	for _, in := range kept {
		if _, didCut := cleanBaseURL(in); didCut {
			t.Errorf("cleanBaseURL(%q) reported a cut it should not have", in)
		}
	}
}

// baseURLComplaint is what turns the defect above from silent into loud. It is
// tested directly because the warn switch it feeds only logs.
func TestBaseURLComplaint(t *testing.T) {
	sound := []string{
		"https://aurora.example.com",
		"http://aurora.example.com",
		"https://aurora.example.com/aurora",
		"https://aurora.example.com:8443",
	}
	for _, s := range sound {
		if c := baseURLComplaint(s); c != "" {
			t.Errorf("baseURLComplaint(%q) = %q, want no complaint", s, c)
		}
	}

	// Note these are RAW inputs to the complaint, not post-clean values — the
	// composed behaviour is TestCleanThenComplain's job. Whitespace here is the
	// signature of the systemd/shell mismatch.
	unsound := []string{
		"https://aurora.example.com   # no trailing slash",
		"https://aurora.example.com/base#frag",
		"https://aurora.example.com/base?a=1",
		"https://aurora example.com",
		"aurora.example.com",
		"",
		"/api/feedback",
	}
	for _, s := range unsound {
		if baseURLComplaint(s) == "" {
			t.Errorf("baseURLComplaint(%q) = \"\", want a complaint", s)
		}
	}
}
