package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server     ServerConfig
	Database   DatabaseConfig
	Auth       AuthConfig
	Scanner    ScannerConfig
	TMDB       TMDBConfig
	TVDB       TVDBConfig
	Cache      CacheConfig
	Transcode  TranscodeConfig
	TLS        TLSConfig
	Logging    LogConfig
	Requests   RequestsConfig
	WatchParty WatchPartyConfig
	LLM        LLMConfig
	BugReport  BugReportConfig
}

// BugReportConfig controls the in-app "Report a Bug" feature. When
// disabled (default), the frontend hides the launcher button and the
// backend rejects /api/feedback submissions with 404. Operators turn it
// on by setting BUG_REPORT_ENABLED=true and providing a GitHub PAT +
// repo + public-base URL.
//
// Why env-var-only (not server_settings DB): the GitHub PAT has write
// access to the repo; server_settings stores values as plaintext today,
// so DB storage is the wrong layer until encryption-at-rest lands.
//
// PublicBaseURL is the externally-reachable URL of this Aurora deploy
// (e.g. "https://aurora.example.com"). Used to build absolute attachment
// URLs that GitHub's image proxy can fetch when rendering the issue
// body. Must NOT include a trailing slash.
type BugReportConfig struct {
	Enabled       bool
	GitHubToken   string // PAT with Issues:write + Contents:read scope (or full `repo` for private repos)
	GitHubRepo    string // "owner/repo", e.g. "your-org/aurora-bug-reports"
	PublicBaseURL string // e.g. "https://aurora.example.com" (no trailing slash)

	// 2026-05-27 — Operational tunables. Defaults match the values
	// shipped as bare constants in Phase 3; operators only need to
	// touch these for non-default policies (heavily-shared deploys
	// that want stricter throttling, or low-volume deploys that
	// want longer attachment retention).
	//
	// All four accept zero as "use the default" so partially-set
	// configs don't fall off a cliff.
	RateLimitMax         int           // max submits per user per window. Env: BUG_REPORT_RATE_LIMIT_MAX (default 5)
	RateLimitWindow      time.Duration // duration of the rate-limit window. Env: BUG_REPORT_RATE_LIMIT_WINDOW_HOURS (default 1h)
	AttachmentTTL        time.Duration // janitor: delete attachments older than this. Env: BUG_REPORT_ATTACHMENT_TTL_DAYS (default 30d)
	JanitorSweepInterval time.Duration // janitor: how often to sweep. Env: BUG_REPORT_JANITOR_INTERVAL_HOURS (default 1h)
}

// LLMConfig governs the local-LLM sidecar used for semantic search and
// natural-language query parsing. When Enabled is false the rest of the
// system falls back to the existing trigram path; nothing else needs to know.
type LLMConfig struct {
	Enabled bool
	// Provider / EmbedProvider select the chat and embedding backends
	// independently ("" = legacy Ollama behavior). Values mirror
	// internal/llm: local | ollama_cloud | anthropic | openai for chat,
	// local | openai for embeds (Anthropic has no embeddings API). Envs
	// LLM_PROVIDER / LLM_EMBED_PROVIDER; usually set from the admin UI via
	// server_settings, which overrides these at boot (applyLLMOverrides).
	Provider      string
	EmbedProvider string
	// Hosted-provider API keys (LLM_ANTHROPIC_API_KEY / LLM_OPENAI_API_KEY,
	// or the llm_*_api_key settings rows). Each key only ever rides to its
	// own provider's fixed host — see internal/llm key-isolation notes.
	AnthropicAPIKey string
	OpenAIAPIKey    string
	// Env-only base-URL overrides for gateway/proxy deployments
	// (LLM_ANTHROPIC_BASE_URL / LLM_OPENAI_BASE_URL). Deliberately NOT
	// admin-editable: a stored key must never be steerable to an
	// operator-form-supplied host.
	AnthropicBaseURL string
	OpenAIBaseURL    string
	OllamaURL        string        // e.g. http://localhost:11434
	EmbedModel       string        // Ollama tag for the embedding model
	ChatModel        string        // Ollama tag for the query-parser / reranker
	EmbedDims        int           // target vector dimensionality (must match migration)
	BackfillWorkers  int           // parallel backfill goroutines
	BackfillBatch    int           // items per Ollama batch
	HTTPTimeout      time.Duration // per-request budget
	// NumCtx (env LLM_NUM_CTX) is sent as options.num_ctx on native
	// /api/chat calls when > 0. Ollama's default context (4096) silently
	// truncates over-long prompts; our prompt caps are tuned to stay
	// under it, but operators running bigger candidate pools or wordier
	// catalogs can raise this instead of discovering truncation the hard
	// way. 0 (default) omits the option → Ollama/model default applies.
	NumCtx int

	// AI-driven re-matching for items the heuristic enricher flagged as
	// 'needs_review' (TMDB confidence 50..84). See internal/matching.
	//
	// AIMatchAutoThreshold is the LLM-confidence floor at which an item
	// auto-promotes to match_status='matched' via the existing
	// EnrichByTMDBID path. Default 90 — strictly higher than the heuristic
	// AutoMatchThreshold default (85) because the LLM's self-reported
	// score is less calibrated and we want a conservative bar before
	// changing user-visible state without operator approval. Env:
	// AI_MATCH_AUTO_THRESHOLD.
	//
	// AIMatchRatePerSec throttles the background backfill so a large
	// flagged queue doesn't saturate Ollama (which would slow down search
	// and the recommender stack sharing the same model). Default 1/sec.
	// LLM-call latency dominates this in practice, so the rate limit is a
	// floor that mostly matters on fast local models. Env:
	// AI_MATCH_RATE_PER_SEC.
	AIMatchAutoThreshold int
	AIMatchRatePerSec    float64
}

// WatchPartyConfig holds watch-party deployment configuration.
//
// 2026-06 V2 deletion — the V2 sync tunables (HeartbeatInterval,
// BufferHysteresis, Drift*, …) were removed along with the protocol that
// consumed them; the V3 engine's thresholds live in
// watchparty.DefaultSyncConfig. Setting the old `watchparty:` yaml keys
// now logs a deprecation warning at startup (see loadYAML) instead of
// being silently ignored.
type WatchPartyConfig struct {
	// M8 — voice (WebRTC) ICE configuration. The defaults work for
	// same-network and most home-NAT setups (Google's public STUN).
	// For cross-NAT calls (friends behind symmetric or carrier-grade
	// NAT), operators must deploy a TURN server (recommended: coturn,
	// BSD-3) and set the URL/credential env vars. The frontend
	// fetches this config via /api/voice/ice-servers on join so we
	// can rotate credentials without redeploying the SPA.
	VoiceSTUNServers    []string // STUN URLs (e.g. "stun:stun.l.google.com:19302")
	VoiceTURNURL        string   // TURN URL (e.g. "turn:turn.aurora.example:3478") — empty disables TURN
	VoiceTURNUsername   string   // TURN long-term credential username
	VoiceTURNCredential string   // TURN long-term credential secret
}

// RequestsConfig holds configuration for the media Requests feature,
// including Radarr/Sonarr integration for automated downloading.
type RequestsConfig struct {
	Enabled  bool              // Master toggle for the requests feature
	Radarr   ArrInstanceConfig // Standard quality Radarr instance
	Radarr4K ArrInstanceConfig // 4K quality Radarr instance (optional)
	Sonarr   ArrInstanceConfig // Standard quality Sonarr instance
	Sonarr4K ArrInstanceConfig // 4K quality Sonarr instance (optional)
}

// ArrInstanceConfig holds the connection info for a single Radarr or Sonarr instance.
type ArrInstanceConfig struct {
	URL    string // Base URL (e.g. http://localhost:7878)
	APIKey string // API key for authentication
}

type LogConfig struct {
	Dir        string // Directory for log files
	Level      string // Log level: debug, info, warn, error
	MaxSizeMB  int    // Max size in MB before rotation
	MaxBackups int    // Max number of old log files to retain
	MaxAgeDays int    // Max number of days to retain old log files
	Compress   bool   // Whether to gzip rotated log files
}

type TLSConfig struct {
	Enabled  bool   `yaml:"enabled"`
	CertFile string `yaml:"cert_file"`
	KeyFile  string `yaml:"key_file"`
	AutoCert bool   `yaml:"auto_cert"`
	Domain   string `yaml:"domain"`
	CacheDir string `yaml:"cache_dir"`
}

type ServerConfig struct {
	Host           string
	Port           int
	AllowedOrigins []string
	// TrustedProxies is an allowlist of CIDR ranges (e.g. "10.0.0.0/8",
	// "192.168.1.5/32") whose X-Forwarded-For / X-Real-IP headers we'll
	// honor. Empty (default) means "no proxy trust" — RemoteAddr is the
	// source of truth, which is the secure-by-default posture. Set this
	// ONLY for the IPs of reverse proxies you control; misconfiguration
	// here lets external clients forge their apparent IP and bypass the
	// auth rate limiter.
	TrustedProxies []string
	// SecureCookies forces the Secure attribute on auth cookies even when
	// Aurora itself sees plain HTTP — set this when a TLS-terminating reverse
	// proxy fronts it (the documented topology), where r.TLS is nil. Without
	// it, the auth cookies would be sent over plain HTTP. deep-debug H10.
	// Env: AURORA_SECURE_COOKIES.
	SecureCookies bool
}

type DatabaseConfig struct {
	URL             string
	MaxConns        int32
	MinConns        int32
	MaxConnLifetime time.Duration
}

type AuthConfig struct {
	JWTSecret          string
	AccessTokenExpiry  time.Duration
	RefreshTokenExpiry time.Duration
	// CastTokenExpiry bounds the lifetime of session-scoped tokens
	// embedded in Chromecast/AirPlay URLs. Long enough to cover a feature
	// film without mid-playback rotation; short enough that a leaked
	// token expires before it could be used to drain a transcode quota
	// long-term. Default 4h.
	CastTokenExpiry   time.Duration
	Argon2Memory      uint32
	Argon2Iterations  uint32
	Argon2Parallelism uint8
	Argon2SaltLength  uint32
	Argon2KeyLength   uint32
	InviteCodeLength  int
}

type ScannerConfig struct {
	Workers       int
	FFprobePath   string
	WatchDebounce time.Duration
}

type TMDBConfig struct {
	APIKey             string
	MetadataRefresh    time.Duration
	Language           string
	AutoMatchThreshold int // confidence >= this → auto-matched (env: MATCH_AUTO_THRESHOLD)
	ReviewThreshold    int // confidence >= this → needs_review (env: MATCH_REVIEW_THRESHOLD)
}

type TVDBConfig struct {
	APIKey   string // TVDB V4 API key
	PIN      string // Optional subscriber PIN
	Enabled  bool   // Auto-enabled in Load when an API key is present; TVDB_ENABLED=false opts out
	Language string // 3-letter language code (e.g. "eng", "deu", "jpn")
}

type CacheConfig struct {
	ImageDir     string
	TranscodeDir string
	SubtitleDir  string
}

type TranscodeConfig struct {
	MaxSessions int
	// MaxSessionsPerUser bounds how many of the global transcode slots one
	// account may hold. <= 0 means "use the manager's built-in default"
	// (3) — never unlimited, so a single user or leaked token cannot pin
	// every slot (streaming review 2026-06 finding S1).
	MaxSessionsPerUser int
	HWAccel            string
	SessionTimeout     time.Duration
	SegmentDuration    int
	// SegmentFormat selects the HLS segment container: "fmp4" (default —
	// CMAF fragmented MP4, required by Apple for HEVC, no client-side
	// TS remux) or "ts" (legacy MPEG-TS, kept as a rollback path).
	SegmentFormat string
	// HWDecode controls GPU-accelerated DECODE for transcode sessions
	// (2026-07): "auto" (default — probe at startup, use where proven) or
	// "off" (rollback knob: encode-side acceleration only, the pre-2026-07
	// pipeline). Decode offload is what removes the dominant CPU cost of
	// the 4K-HEVC→H.264 transcode; see streaming.ProbeHWDecode.
	HWDecode string
	// SoftwarePreset is the libx264/libx265 preset for SOFTWARE transcodes.
	// Default "veryfast". "faster" buys ~5-8% quality at ~30% more CPU for
	// operators who prefer quality over warmup speed. Validated against the
	// x264 realtime-capable presets in NewTranscodeManager; unknown values
	// fall back to "veryfast".
	//
	// When set it OVERRIDES whatever preset QualityPolicy would pick for the
	// software encoders — it is the more specific knob and predates the
	// policy. It has never had any effect on hardware encoders.
	SoftwarePreset string
	// QualityPolicy is the operator's speed/quality preference, resolved
	// per encoder family (streaming.QualityPolicy): "balanced" (default),
	// "fast_start" or "quality".
	//
	// It exists because software_preset only ever reached libx264/libx265 —
	// two of the ten encoder paths. NVENC/QSV/AMF carried hardcoded values
	// and VAAPI, the most common self-hosted backend, had no quality knob
	// at all. "balanced" reproduces the historical arguments exactly on
	// every family, so upgrading without setting this changes nothing.
	QualityPolicy string
	// HEVCOutput controls HEVC transcode OUTPUT (2026-08): "auto"
	// (default — probe the hevc_* counterpart of the detected HARDWARE
	// encoder, emit HEVC for HEVC-capable clients), "all" (also admit
	// libx265 on CPU-only hosts — opt-in, because a one-frame probe says
	// nothing about x265 keeping up with playback at the upper rungs) or
	// "off" (every transcode stays on H.264, the pre-2026-08 behavior).
	HEVCOutput string
	// StereoDownmix picks how multichannel audio is folded into the stereo
	// AAC the re-encode path emits (streaming.StereoDownmix): "standard"
	// (default — the ITU matrix, written out explicitly, plus a limiter so
	// loud passages stop clipping), "dialogue" (centre-forward), "night"
	// (dialogue-forward plus dynamic-range compression) or "legacy" (the
	// bare `-ac 2` fold, byte-identical to installs before the knob).
	StereoDownmix string
	Profiles      []string
	// MaxCacheBytes bounds the total on-disk size of the transcode output
	// tree (HLS EVENT playlists keep every segment of a title so seek-back
	// works, so long/concurrent transcodes can grow it without bound). When
	// exceeded, the manager evicts least-recently-used idle sessions. <= 0
	// means "use the manager's built-in default" — never truly unbounded.
	MaxCacheBytes int64
}

// --- YAML schema ---

type yamlConfig struct {
	Server struct {
		Host           string   `yaml:"host"`
		Port           int      `yaml:"port"`
		AllowedOrigins []string `yaml:"allowed_origins"`
		TrustedProxies []string `yaml:"trusted_proxies"`
		SecureCookies  bool     `yaml:"secure_cookies"`
	} `yaml:"server"`
	Database struct {
		URL      string `yaml:"url"`
		MaxConns int    `yaml:"max_conns"`
		MinConns int    `yaml:"min_conns"`
	} `yaml:"database"`
	Auth struct {
		JWTSecret          string `yaml:"jwt_secret"`
		AccessTokenMinutes int    `yaml:"access_token_minutes"`
		RefreshTokenDays   int    `yaml:"refresh_token_days"`
		CastTokenHours     int    `yaml:"cast_token_hours"`
		// CastTokenMinutes lets operators configure sub-hour cast
		// TTLs (e.g. 5 minutes to match a tight SessionTimeout).
		// If both CastTokenHours and CastTokenMinutes are set,
		// CastTokenMinutes wins (more granular).
		CastTokenMinutes int `yaml:"cast_token_minutes"`
	} `yaml:"auth"`
	Scanner struct {
		Workers         int    `yaml:"workers"`
		FFprobePath     string `yaml:"ffprobe_path"`
		WatchDebounceMs int    `yaml:"watch_debounce_ms"`
	} `yaml:"scanner"`
	TMDB struct {
		APIKey               string `yaml:"api_key"`
		MetadataRefreshHours int    `yaml:"metadata_refresh_hours"`
		Language             string `yaml:"language"`
		AutoMatchThreshold   int    `yaml:"auto_match_threshold"`
		ReviewThreshold      int    `yaml:"review_threshold"`
	} `yaml:"tmdb"`
	TVDB struct {
		APIKey   string `yaml:"api_key"`
		PIN      string `yaml:"pin"`
		Enabled  bool   `yaml:"enabled"`
		Language string `yaml:"language"`
	} `yaml:"tvdb"`
	Cache struct {
		ImageDir     string `yaml:"image_dir"`
		TranscodeDir string `yaml:"transcode_dir"`
		SubtitleDir  string `yaml:"subtitle_dir"`
	} `yaml:"cache"`
	Transcode struct {
		MaxSessions        int      `yaml:"max_sessions"`
		MaxSessionsPerUser int      `yaml:"max_sessions_per_user"`
		HWAccel            string   `yaml:"hw_accel"`
		HWDecode           string   `yaml:"hw_decode"`
		SessionTimeoutSec  int      `yaml:"session_timeout_sec"`
		SegmentDuration    int      `yaml:"segment_duration"`
		SegmentFormat      string   `yaml:"segment_format"`
		SoftwarePreset     string   `yaml:"software_preset"`
		QualityPolicy      string   `yaml:"quality_policy"`
		HEVCOutput         string   `yaml:"hevc_output"`
		StereoDownmix      string   `yaml:"stereo_downmix"`
		Profiles           []string `yaml:"profiles"`
		MaxCacheGB         int      `yaml:"max_cache_gb"`
	} `yaml:"transcode"`
	TLS struct {
		Enabled  bool   `yaml:"enabled"`
		CertFile string `yaml:"cert_file"`
		KeyFile  string `yaml:"key_file"`
		AutoCert bool   `yaml:"auto_cert"`
		Domain   string `yaml:"domain"`
		CacheDir string `yaml:"cache_dir"`
	} `yaml:"tls"`
	Logging struct {
		Dir        string `yaml:"dir"`
		Level      string `yaml:"level"`
		MaxSizeMB  int    `yaml:"max_size_mb"`
		MaxBackups int    `yaml:"max_backups"`
		MaxAgeDays int    `yaml:"max_age_days"`
		Compress   bool   `yaml:"compress"`
	} `yaml:"logging"`
	Requests struct {
		Enabled bool `yaml:"enabled"`
		Radarr  struct {
			URL    string `yaml:"url"`
			APIKey string `yaml:"api_key"`
		} `yaml:"radarr"`
		Radarr4K struct {
			URL    string `yaml:"url"`
			APIKey string `yaml:"api_key"`
		} `yaml:"radarr_4k"`
		Sonarr struct {
			URL    string `yaml:"url"`
			APIKey string `yaml:"api_key"`
		} `yaml:"sonarr"`
		Sonarr4K struct {
			URL    string `yaml:"url"`
			APIKey string `yaml:"api_key"`
		} `yaml:"sonarr_4k"`
	} `yaml:"requests"`
	// 2026-06 V2 deletion — these keys configured the removed V2 sync
	// protocol. They are still PARSED solely so loadYAML can warn an
	// operator whose aurora.yaml sets them that they no longer do
	// anything; the values are never applied.
	WatchParty struct {
		HeartbeatIntervalMs int   `yaml:"heartbeat_interval_ms"`
		TimeSyncIntervalMs  int   `yaml:"time_sync_interval_ms"`
		BufferHysteresisMs  int   `yaml:"buffer_hysteresis_ms"`
		PlayScheduleDelayMs int   `yaml:"play_schedule_delay_ms"`
		DriftIgnoreMs       int64 `yaml:"drift_ignore_ms"`
		DriftRateAdjustMs   int64 `yaml:"drift_rate_adjust_ms"`
		DriftHardSeekMs     int64 `yaml:"drift_hard_seek_ms"`
		DriftMaxAttempts    int   `yaml:"drift_max_attempts"`
	} `yaml:"watchparty"`
}

// Default returns the configuration with every field at its built-in default,
// before any YAML file or environment override is applied.
//
// Extracted from Load so the defaults are reachable on their own. They carry
// real behaviour: transcode.software_preset defaulting to a concrete preset
// silently disabled quality_policy on every software install, and no test
// could see it because they all hand-built their own config structs.
func Default() *Config {
	return &Config{
		Server: ServerConfig{
			Host:           "0.0.0.0",
			Port:           8484,
			AllowedOrigins: parseOrigins("http://localhost:*,https://localhost:*"),
		},
		Database: DatabaseConfig{
			URL:             "postgres://aurora:aurora@localhost:5432/aurora?sslmode=disable",
			MaxConns:        10,
			MinConns:        2,
			MaxConnLifetime: time.Hour,
		},
		Auth: AuthConfig{
			AccessTokenExpiry:  15 * time.Minute,
			RefreshTokenExpiry: 30 * 24 * time.Hour,
			CastTokenExpiry:    4 * time.Hour,
			Argon2Memory:       64 * 1024,
			Argon2Iterations:   3,
			Argon2Parallelism:  4,
			Argon2SaltLength:   16,
			Argon2KeyLength:    32,
			InviteCodeLength:   16,
		},
		Scanner: ScannerConfig{
			Workers:       8,
			FFprobePath:   "ffprobe",
			WatchDebounce: 2000 * time.Millisecond,
		},
		TMDB: TMDBConfig{
			// Bundled application key (2026-07-18) — registered for the
			// Aurora project so fresh installs need no per-user signup,
			// the same model Jellyfin and Kodi use. TMDB rate-limits per
			// client IP rather than per key, so self-hosted installs
			// sharing this key don't affect each other. Override with
			// TMDB_API_KEY (env) or tmdb.api_key (yaml). TMDB's terms
			// require the attribution notice rendered in Settings.
			APIKey:             "8051eb7a3f6f762b94b77ed7b9838bad",
			MetadataRefresh:    168 * time.Hour,
			Language:           "en",
			AutoMatchThreshold: 85,
			ReviewThreshold:    50,
		},
		TVDB: TVDBConfig{
			// Bundled v4 project key (2026-07-18) — authenticates without
			// a subscriber PIN (verified against api4.thetvdb.com), so the
			// TVDB fallback works out of the box: the auto-enable in Load
			// flips Enabled to true because this key is present.
			// TVDB_ENABLED=false opts out; TVDB_PIN remains available for
			// user-supported subscriptions; TVDB_API_KEY overrides.
			APIKey:   "1bd0745a-f255-4a26-9fc2-5e9d0214ee89",
			Enabled:  false,
			Language: "eng",
		},
		Cache: CacheConfig{
			ImageDir:     "/var/cache/aurora/images",
			TranscodeDir: "/tmp/aurora-transcode",
			SubtitleDir:  "/var/cache/aurora/subtitles",
		},
		Transcode: TranscodeConfig{
			MaxSessions: 0,
			// 0 = manager default (3): one active stream + a seek-rebuild's
			// transient second session + a stereo cast clone.
			MaxSessionsPerUser: 0,
			HWAccel:            "auto",
			// GPU decode offload: probe at startup, use where proven.
			// "off" restores the encode-only acceleration pipeline.
			HWDecode: "auto",
			// 5 minutes (was 120s). Keepalive pings every 10s, but browsers
			// throttle/suspend timers in backgrounded tabs and on locked
			// phones; a 2-minute idle window let a backgrounded stream's
			// session get GC'd (segments deleted) before the tab returned,
			// breaking playback on resume. 5 min covers typical background
			// gaps while still reclaiming truly-abandoned sessions.
			SessionTimeout:  300 * time.Second,
			SegmentDuration: 6,
			// fMP4 (CMAF) segments by default — Apple's HLS spec requires
			// fMP4 for HEVC, and hls.js skips its TS→fMP4 remux entirely.
			// Set "ts" to roll back to the legacy MPEG-TS pipeline.
			SegmentFormat: "fmp4",
			// Software-encoder preset. EMPTY by default on purpose: an
			// explicit value overrides quality_policy for the software
			// encoders, so defaulting it to a concrete preset here would
			// make the policy a no-op on every GPU-less install — the most
			// common configuration this project targets. Empty means "let
			// the policy decide", and balanced resolves to veryfast, which
			// is what a default install got before the policy existed.
			SoftwarePreset: "",
			// Speed/quality policy applied across every encoder family.
			// "balanced" reproduces the historical arguments exactly.
			QualityPolicy: "balanced",
			// HEVC transcode output for HEVC-capable clients (probe the
			// hevc_* counterpart of the detected HARDWARE encoder). "all"
			// also admits libx265; "off" keeps every transcode on H.264.
			HEVCOutput: "auto",
			// Explicit ITU stereo fold plus a limiter. "legacy" restores the
			// bare `-ac 2` swresample fold byte-for-byte.
			StereoDownmix: "standard",
			// 2160p included so 4K sources can be offered at full resolution
			// when transcoding is unavoidable. It sits at the TOP of the ABR
			// ladder and variants start on-demand, so low-bandwidth clients
			// never trigger the (expensive) 4K encode — only clients that
			// climb there do. The preferred 4K path is still direct play on
			// capable clients (see DirectPlayCodecs / the caps engine).
			Profiles:      []string{"2160p", "1080p", "720p", "480p"},
			MaxCacheBytes: 20 << 30, // 20 GiB
		},
		Logging: LogConfig{
			Dir:        "/var/log/aurora",
			Level:      "info",
			MaxSizeMB:  100,
			MaxBackups: 5,
			MaxAgeDays: 30,
			Compress:   true,
		},
		LLM: LLMConfig{
			Enabled: true,
			// localhost, not the old Docker-style `http://ollama:11434`:
			// Aurora deploys on bare metal (systemd), where the `ollama`
			// hostname doesn't resolve. The Docker-hostname default made
			// manual installs (anyone not using install.sh, which papers
			// over it via LLM_OLLAMA_URL) silently fall back to keyword
			// search — reported 2026-07-17.
			OllamaURL: "http://localhost:11434",
			// Phase E4: qwen3-embedding:0.6b (1024-dim native, MRL) is the
			// 2026 small-embedder quality leader; the client truncates its
			// Matryoshka output to EmbedDims=768 so migration 040's
			// vector(768) column and HNSW index carry over unchanged.
			EmbedModel: "qwen3-embedding:0.6b",
			// Phase E4: qwen3:4b-instruct (non-thinking 2507 line) replaces
			// qwen2.5:3b-instruct — better instruction-following and JSON
			// discipline at a comparable CPU footprint.
			ChatModel:       "qwen3:4b-instruct",
			EmbedDims:       768, // must match migration 040's vector(768); qwen3-embedding is MRL-truncated to this
			BackfillWorkers: 2,
			BackfillBatch:   16,
			// 70s = 10s margin over the longest recommender per-call
			// ctx (discoverBudget = 60s). See llm/client.go for the
			// rationale; keep this in sync with that default.
			HTTPTimeout: 70 * time.Second,
			// AI matcher defaults — see field comments above.
			AIMatchAutoThreshold: 90,
			AIMatchRatePerSec:    1.0,
		},
		WatchParty: WatchPartyConfig{
			// M8 — voice defaults. Public STUN works for most home-NAT
			// setups; TURN is empty by default (no relay). Operators
			// deploying coturn populate the TURN_* env vars at boot.
			VoiceSTUNServers: []string{"stun:stun.l.google.com:19302"},
		},
	}
}

// Load reads configuration from YAML file (if present) then overlays environment variables.
// Environment variables always take precedence over the YAML file.
func Load() (*Config, error) {
	cfg := Default()

	// Phase 1: Load from YAML config file if it exists
	if err := loadYAML(cfg); err != nil {
		slog.Warn("failed to load yaml config (continuing with defaults + env)", "error", err)
	}

	// Phase 2: Environment variables override everything
	applyEnvOverrides(cfg)

	// Validation
	if cfg.Auth.JWTSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET environment variable is required")
	}

	blockedSecrets := []string{
		"change-me-to-a-random-64-char-string-in-production",
		"change-me-to-something-random-and-at-least-64-characters-long-please",
	}
	for _, blocked := range blockedSecrets {
		if cfg.Auth.JWTSecret == blocked {
			return nil, fmt.Errorf("JWT_SECRET is set to a known placeholder — generate a real secret (e.g. `openssl rand -hex 32`)")
		}
	}
	if len(cfg.Auth.JWTSecret) < 32 {
		return nil, fmt.Errorf("JWT_SECRET must be at least 32 characters long")
	}

	// Unreachable while the bundled default key ships; kept as a guard
	// in case the default is ever removed or blanked by a fork.
	if cfg.TMDB.APIKey == "" {
		return nil, fmt.Errorf("no TMDB API key configured — set TMDB_API_KEY (get one at https://www.themoviedb.org/settings/api)")
	}

	// Auto-enable TVDB if API key is provided
	if cfg.TVDB.APIKey != "" {
		explicitDisable := os.Getenv("TVDB_ENABLED")
		if explicitDisable != "false" && explicitDisable != "0" && explicitDisable != "no" {
			cfg.TVDB.Enabled = true
		}
	}

	// Cross-field / sentinel validation that can't be expressed as a simple
	// per-field check above. Runs here so a misconfiguration fails the boot
	// rather than degrading silently at request time.
	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	return cfg, nil
}

// Validate performs cross-field configuration checks that must hold before
// the server starts serving. It is called at the end of Load (so a bad
// config fails the boot loudly) and is safe to call again from tests.
//
// Today its sole job is the CORS credentials footgun: the router hardcodes
// cors.Options.AllowCredentials=true (cookies are required for the OAuth
// login flow). go-chi/cors, when the allowed-origins list contains the "*"
// wildcard AND credentials are enabled, reflects `Access-Control-Allow-Origin: *`
// alongside `Access-Control-Allow-Credentials: true` — a combination every
// browser rejects, silently breaking every credentialed/cookie request
// (login, refresh, all authed XHR). Rather than let that ship as a
// hard-to-diagnose "CORS error" in the user's console, we refuse to start
// and tell the operator exactly what to do.
func (c *Config) Validate() error {
	// AllowCredentials is hardcoded true in NewRouter (cookies for OAuth);
	// keep this guard in sync if that ever becomes configurable.
	const credentialedCORS = true
	if credentialedCORS {
		for _, o := range c.Server.AllowedOrigins {
			if o == "*" {
				return fmt.Errorf("AURORA_ALLOWED_ORIGINS=* is unsupported with credentialed CORS " +
					"(browsers reject Access-Control-Allow-Origin:* together with credentials:true, " +
					"silently breaking cookie/OAuth login) — list explicit scheme+host[:port] origins " +
					"instead, e.g. https://aurora.example.com (a localhost:* port-wildcard is fine)")
			}
		}
	}
	return nil
}

func loadYAML(cfg *Config) error {
	configPath := os.Getenv("AURORA_CONFIG_FILE")
	if configPath == "" {
		candidates := []string{
			"configs/aurora.yaml",
			"configs/aurora.yml",
			"aurora.yaml",
			"aurora.yml",
		}
		if exe, err := os.Executable(); err == nil {
			dir := filepath.Dir(exe)
			candidates = append(candidates,
				filepath.Join(dir, "configs", "aurora.yaml"),
				filepath.Join(dir, "aurora.yaml"),
			)
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				configPath = c
				break
			}
		}
	}

	if configPath == "" {
		return nil
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", configPath, err)
	}

	var yc yamlConfig
	if err := yaml.Unmarshal(data, &yc); err != nil {
		return fmt.Errorf("parse %s: %w", configPath, err)
	}

	slog.Info("loaded yaml config", "path", configPath)

	if yc.Server.Host != "" {
		cfg.Server.Host = yc.Server.Host
	}
	if yc.Server.Port > 0 {
		cfg.Server.Port = yc.Server.Port
	}
	if len(yc.Server.AllowedOrigins) > 0 {
		cfg.Server.AllowedOrigins = yc.Server.AllowedOrigins
	}
	if len(yc.Server.TrustedProxies) > 0 {
		cfg.Server.TrustedProxies = yc.Server.TrustedProxies
	}
	if yc.Server.SecureCookies {
		cfg.Server.SecureCookies = true
	}
	if yc.Database.URL != "" {
		cfg.Database.URL = yc.Database.URL
	}
	if yc.Database.MaxConns > 0 {
		cfg.Database.MaxConns = int32(yc.Database.MaxConns)
	}
	if yc.Database.MinConns > 0 {
		cfg.Database.MinConns = int32(yc.Database.MinConns)
	}
	if yc.Auth.JWTSecret != "" {
		cfg.Auth.JWTSecret = yc.Auth.JWTSecret
	}
	if yc.Auth.AccessTokenMinutes > 0 {
		cfg.Auth.AccessTokenExpiry = time.Duration(yc.Auth.AccessTokenMinutes) * time.Minute
	}
	if yc.Auth.RefreshTokenDays > 0 {
		cfg.Auth.RefreshTokenExpiry = time.Duration(yc.Auth.RefreshTokenDays) * 24 * time.Hour
	}
	if yc.Auth.CastTokenHours > 0 {
		cfg.Auth.CastTokenExpiry = time.Duration(yc.Auth.CastTokenHours) * time.Hour
	}
	// Minutes wins over hours when both are set — it's the more granular
	// expression of intent. An operator who sets cast_token_minutes:5
	// after a previous cast_token_hours:4 wants the new value to take
	// effect without having to also clear the old one.
	if yc.Auth.CastTokenMinutes > 0 {
		cfg.Auth.CastTokenExpiry = time.Duration(yc.Auth.CastTokenMinutes) * time.Minute
	}
	if yc.Scanner.Workers > 0 {
		cfg.Scanner.Workers = yc.Scanner.Workers
	}
	if yc.Scanner.FFprobePath != "" {
		cfg.Scanner.FFprobePath = yc.Scanner.FFprobePath
	}
	if yc.Scanner.WatchDebounceMs > 0 {
		cfg.Scanner.WatchDebounce = time.Duration(yc.Scanner.WatchDebounceMs) * time.Millisecond
	}
	if yc.TMDB.APIKey != "" {
		cfg.TMDB.APIKey = yc.TMDB.APIKey
	}
	if yc.TMDB.MetadataRefreshHours > 0 {
		cfg.TMDB.MetadataRefresh = time.Duration(yc.TMDB.MetadataRefreshHours) * time.Hour
	}
	if yc.TMDB.Language != "" {
		cfg.TMDB.Language = yc.TMDB.Language
	}
	if yc.TMDB.AutoMatchThreshold > 0 {
		cfg.TMDB.AutoMatchThreshold = yc.TMDB.AutoMatchThreshold
	}
	if yc.TMDB.ReviewThreshold > 0 {
		cfg.TMDB.ReviewThreshold = yc.TMDB.ReviewThreshold
	}
	if yc.TVDB.APIKey != "" {
		cfg.TVDB.APIKey = yc.TVDB.APIKey
	}
	if yc.TVDB.PIN != "" {
		cfg.TVDB.PIN = yc.TVDB.PIN
	}
	if yc.TVDB.Enabled {
		cfg.TVDB.Enabled = true
	}
	if yc.TVDB.Language != "" {
		cfg.TVDB.Language = yc.TVDB.Language
	}
	if yc.Cache.ImageDir != "" {
		cfg.Cache.ImageDir = yc.Cache.ImageDir
	}
	if yc.Cache.TranscodeDir != "" {
		cfg.Cache.TranscodeDir = yc.Cache.TranscodeDir
	}
	if yc.Cache.SubtitleDir != "" {
		cfg.Cache.SubtitleDir = yc.Cache.SubtitleDir
	}
	if yc.Transcode.MaxSessions > 0 {
		cfg.Transcode.MaxSessions = yc.Transcode.MaxSessions
	}
	if yc.Transcode.HWAccel != "" {
		cfg.Transcode.HWAccel = yc.Transcode.HWAccel
	}
	if yc.Transcode.SessionTimeoutSec > 0 {
		cfg.Transcode.SessionTimeout = time.Duration(yc.Transcode.SessionTimeoutSec) * time.Second
	}
	if yc.Transcode.SegmentDuration > 0 {
		cfg.Transcode.SegmentDuration = yc.Transcode.SegmentDuration
	}
	if yc.Transcode.SegmentFormat != "" {
		cfg.Transcode.SegmentFormat = yc.Transcode.SegmentFormat
	}
	if yc.Transcode.HWDecode != "" {
		cfg.Transcode.HWDecode = yc.Transcode.HWDecode
	}
	if yc.Transcode.SoftwarePreset != "" {
		cfg.Transcode.SoftwarePreset = yc.Transcode.SoftwarePreset
	}
	if yc.Transcode.QualityPolicy != "" {
		cfg.Transcode.QualityPolicy = yc.Transcode.QualityPolicy
	}
	if yc.Transcode.HEVCOutput != "" {
		cfg.Transcode.HEVCOutput = yc.Transcode.HEVCOutput
	}
	if yc.Transcode.StereoDownmix != "" {
		cfg.Transcode.StereoDownmix = yc.Transcode.StereoDownmix
	}
	if yc.Transcode.MaxSessionsPerUser > 0 {
		cfg.Transcode.MaxSessionsPerUser = yc.Transcode.MaxSessionsPerUser
	}
	if len(yc.Transcode.Profiles) > 0 {
		cfg.Transcode.Profiles = yc.Transcode.Profiles
	}
	if yc.Transcode.MaxCacheGB > 0 {
		cfg.Transcode.MaxCacheBytes = int64(yc.Transcode.MaxCacheGB) << 30
	}
	if yc.TLS.Enabled {
		cfg.TLS.Enabled = true
	}
	if yc.TLS.CertFile != "" {
		cfg.TLS.CertFile = yc.TLS.CertFile
	}
	if yc.TLS.KeyFile != "" {
		cfg.TLS.KeyFile = yc.TLS.KeyFile
	}
	if yc.TLS.AutoCert {
		cfg.TLS.AutoCert = true
	}
	if yc.TLS.Domain != "" {
		cfg.TLS.Domain = yc.TLS.Domain
	}
	if yc.TLS.CacheDir != "" {
		cfg.TLS.CacheDir = yc.TLS.CacheDir
	}
	if yc.Logging.Dir != "" {
		cfg.Logging.Dir = filepath.Clean(yc.Logging.Dir)
	}
	if yc.Logging.Level != "" {
		cfg.Logging.Level = yc.Logging.Level
	}
	if yc.Logging.MaxSizeMB > 0 {
		cfg.Logging.MaxSizeMB = yc.Logging.MaxSizeMB
	}
	if yc.Logging.MaxBackups > 0 {
		cfg.Logging.MaxBackups = yc.Logging.MaxBackups
	}
	if yc.Logging.MaxAgeDays > 0 {
		cfg.Logging.MaxAgeDays = yc.Logging.MaxAgeDays
	}
	// Note: Compress cannot use the `if yc.X { cfg.X = true }` pattern
	// because the default is true, and we need to allow YAML to set it to false.
	// However, Go's YAML unmarshalling sets bool fields to false by default,
	// making it impossible to distinguish "not specified" from "explicitly false".
	// We accept this trade-off: if the logging section is present in YAML at all,
	// the compress field will apply (defaulting to false if omitted from YAML).
	// The env var LOG_COMPRESS=true/false provides full control regardless.
	if yc.Logging.Dir != "" || yc.Logging.Level != "" || yc.Logging.MaxSizeMB > 0 ||
		yc.Logging.MaxBackups > 0 || yc.Logging.MaxAgeDays > 0 {
		// Logging section was specified in YAML, apply compress value
		cfg.Logging.Compress = yc.Logging.Compress
	}

	// Requests / ARR integration
	if yc.Requests.Enabled {
		cfg.Requests.Enabled = true
	}
	if yc.Requests.Radarr.URL != "" {
		cfg.Requests.Radarr.URL = yc.Requests.Radarr.URL
	}
	if yc.Requests.Radarr.APIKey != "" {
		cfg.Requests.Radarr.APIKey = yc.Requests.Radarr.APIKey
	}
	if yc.Requests.Radarr4K.URL != "" {
		cfg.Requests.Radarr4K.URL = yc.Requests.Radarr4K.URL
	}
	if yc.Requests.Radarr4K.APIKey != "" {
		cfg.Requests.Radarr4K.APIKey = yc.Requests.Radarr4K.APIKey
	}
	if yc.Requests.Sonarr.URL != "" {
		cfg.Requests.Sonarr.URL = yc.Requests.Sonarr.URL
	}
	if yc.Requests.Sonarr.APIKey != "" {
		cfg.Requests.Sonarr.APIKey = yc.Requests.Sonarr.APIKey
	}
	if yc.Requests.Sonarr4K.URL != "" {
		cfg.Requests.Sonarr4K.URL = yc.Requests.Sonarr4K.URL
	}
	if yc.Requests.Sonarr4K.APIKey != "" {
		cfg.Requests.Sonarr4K.APIKey = yc.Requests.Sonarr4K.APIKey
	}

	// 2026-06 V2 deletion — the watchparty sync tunables configured the
	// removed V2 protocol. Warn loudly (once, at startup) when an
	// aurora.yaml still sets them, rather than silently parsing and
	// dropping the values: an operator "tuning" a dead knob should learn
	// it's dead from the log, not from a fruitless debugging session.
	if yc.WatchParty.HeartbeatIntervalMs > 0 || yc.WatchParty.TimeSyncIntervalMs > 0 ||
		yc.WatchParty.BufferHysteresisMs > 0 || yc.WatchParty.PlayScheduleDelayMs > 0 ||
		yc.WatchParty.DriftIgnoreMs > 0 || yc.WatchParty.DriftRateAdjustMs > 0 ||
		yc.WatchParty.DriftHardSeekMs > 0 || yc.WatchParty.DriftMaxAttempts > 0 {
		slog.Warn("aurora.yaml sets watchparty sync tunables (heartbeat_interval_ms / buffer_hysteresis_ms / drift_* / …) that configured the removed V2 sync protocol — they are ignored; V3 sync tuning is built in (see internal/watchparty DefaultSyncConfig)")
	}

	return nil
}

func applyEnvOverrides(cfg *Config) {
	if v := os.Getenv("AURORA_HOST"); v != "" {
		cfg.Server.Host = v
	}
	if v := os.Getenv("AURORA_PORT"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.Server.Port = i
		}
	}
	if v := os.Getenv("AURORA_ALLOWED_ORIGINS"); v != "" {
		cfg.Server.AllowedOrigins = parseOrigins(v)
	}
	if v := os.Getenv("AURORA_SECURE_COOKIES"); v != "" {
		cfg.Server.SecureCookies = v == "true" || v == "1" || v == "yes"
	}
	// AURORA_TRUSTED_PROXIES — comma-separated CIDRs, e.g.
	// "127.0.0.1/32,::1/128" for the nginx that setup-domain.sh installs.
	//
	// This was YAML-only, which made it unreachable in practice: the managed
	// deployment configures Aurora through /etc/aurora/aurora.env, so the knob
	// could not be set without hand-editing a config file the scripts don't
	// manage. Left unset behind a reverse proxy, EVERY request appears to come
	// from 127.0.0.1 — the per-IP auth rate limiter collapses into one shared
	// global bucket, and audit logs record the proxy's address instead of the
	// client's (visible in production as client_ip=127.0.0.1 on every
	// refresh-replay warning).
	if v := os.Getenv("AURORA_TRUSTED_PROXIES"); v != "" {
		cfg.Server.TrustedProxies = parseTrustedProxies(v)
	}
	if v := os.Getenv("DATABASE_URL"); v != "" {
		cfg.Database.URL = v
	}
	if v := os.Getenv("DB_MAX_CONNS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.Database.MaxConns = int32(i)
		}
	}
	if v := os.Getenv("DB_MIN_CONNS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.Database.MinConns = int32(i)
		}
	}
	if v := os.Getenv("JWT_SECRET"); v != "" {
		cfg.Auth.JWTSecret = v
	}
	if v := os.Getenv("ACCESS_TOKEN_MINUTES"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.Auth.AccessTokenExpiry = time.Duration(i) * time.Minute
		}
	}
	if v := os.Getenv("REFRESH_TOKEN_DAYS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.Auth.RefreshTokenExpiry = time.Duration(i) * 24 * time.Hour
		}
	}
	if v := os.Getenv("CAST_TOKEN_HOURS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			cfg.Auth.CastTokenExpiry = time.Duration(i) * time.Hour
		}
	}
	if v := os.Getenv("CAST_TOKEN_MINUTES"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			cfg.Auth.CastTokenExpiry = time.Duration(i) * time.Minute
		}
	}
	if v := os.Getenv("SCANNER_WORKERS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.Scanner.Workers = i
		}
	}
	if v := os.Getenv("FFPROBE_PATH"); v != "" {
		cfg.Scanner.FFprobePath = v
	}
	if v := os.Getenv("WATCH_DEBOUNCE_MS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.Scanner.WatchDebounce = time.Duration(i) * time.Millisecond
		}
	}
	if v := os.Getenv("TMDB_API_KEY"); v != "" {
		cfg.TMDB.APIKey = v
	}
	if v := os.Getenv("METADATA_REFRESH_HOURS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.TMDB.MetadataRefresh = time.Duration(i) * time.Hour
		}
	}
	if v := os.Getenv("TMDB_LANGUAGE"); v != "" {
		cfg.TMDB.Language = v
	}
	if v := os.Getenv("MATCH_AUTO_THRESHOLD"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			cfg.TMDB.AutoMatchThreshold = i
		}
	}
	if v := os.Getenv("MATCH_REVIEW_THRESHOLD"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			cfg.TMDB.ReviewThreshold = i
		}
	}
	if v := os.Getenv("TVDB_API_KEY"); v != "" {
		cfg.TVDB.APIKey = v
	}
	if v := os.Getenv("TVDB_PIN"); v != "" {
		cfg.TVDB.PIN = v
	}
	if v := os.Getenv("TVDB_ENABLED"); v != "" {
		cfg.TVDB.Enabled = v == "true" || v == "1" || v == "yes"
	}
	if v := os.Getenv("TVDB_LANGUAGE"); v != "" {
		cfg.TVDB.Language = v
	}
	if v := os.Getenv("CACHE_IMAGE_DIR"); v != "" {
		cfg.Cache.ImageDir = v
	}
	if v := os.Getenv("CACHE_TRANSCODE_DIR"); v != "" {
		cfg.Cache.TranscodeDir = v
	}
	if v := os.Getenv("CACHE_SUBTITLE_DIR"); v != "" {
		cfg.Cache.SubtitleDir = v
	}
	if v := os.Getenv("TRANSCODE_MAX_SESSIONS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.Transcode.MaxSessions = i
		}
	}
	if v := os.Getenv("TRANSCODE_HW_ACCEL"); v != "" {
		cfg.Transcode.HWAccel = v
	}
	if v := os.Getenv("TRANSCODE_SESSION_TIMEOUT_SEC"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.Transcode.SessionTimeout = time.Duration(i) * time.Second
		}
	}
	if v := os.Getenv("TRANSCODE_SEGMENT_DURATION"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.Transcode.SegmentDuration = i
		}
	}
	if v := os.Getenv("TRANSCODE_SEGMENT_FORMAT"); v != "" {
		cfg.Transcode.SegmentFormat = v
	}
	if v := os.Getenv("TRANSCODE_QUALITY_POLICY"); v != "" {
		cfg.Transcode.QualityPolicy = v
	}
	if v := os.Getenv("TRANSCODE_HEVC_OUTPUT"); v != "" {
		cfg.Transcode.HEVCOutput = v
	}
	if v := os.Getenv("TRANSCODE_STEREO_DOWNMIX"); v != "" {
		cfg.Transcode.StereoDownmix = v
	}
	if v := os.Getenv("TRANSCODE_MAX_SESSIONS_PER_USER"); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			cfg.Transcode.MaxSessionsPerUser = i
		}
	}
	if v := os.Getenv("TRANSCODE_PROFILES"); v != "" {
		cfg.Transcode.Profiles = splitCSV(v)
	}
	if v := os.Getenv("TRANSCODE_MAX_CACHE_GB"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			cfg.Transcode.MaxCacheBytes = int64(i) << 30
		}
	}
	if v := os.Getenv("TLS_ENABLED"); v != "" {
		cfg.TLS.Enabled = v == "true" || v == "1" || v == "yes"
	}
	if v := os.Getenv("TLS_CERT_FILE"); v != "" {
		cfg.TLS.CertFile = v
	}
	if v := os.Getenv("TLS_KEY_FILE"); v != "" {
		cfg.TLS.KeyFile = v
	}
	if v := os.Getenv("TLS_AUTO_CERT"); v != "" {
		cfg.TLS.AutoCert = v == "true" || v == "1" || v == "yes"
	}
	if v := os.Getenv("TLS_DOMAIN"); v != "" {
		cfg.TLS.Domain = v
	}
	if v := os.Getenv("TLS_CACHE_DIR"); v != "" {
		cfg.TLS.CacheDir = v
	}
	if v := os.Getenv("LOG_DIR"); v != "" {
		cfg.Logging.Dir = filepath.Clean(v)
	}
	if v := os.Getenv("LOG_LEVEL"); v != "" {
		cfg.Logging.Level = v
	}
	if v := os.Getenv("LOG_MAX_SIZE_MB"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			cfg.Logging.MaxSizeMB = i
		}
	}
	if v := os.Getenv("LOG_MAX_BACKUPS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i >= 0 {
			cfg.Logging.MaxBackups = i
		}
	}
	if v := os.Getenv("LOG_MAX_AGE_DAYS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i >= 0 {
			cfg.Logging.MaxAgeDays = i
		}
	}
	if v := os.Getenv("LOG_COMPRESS"); v != "" {
		cfg.Logging.Compress = v == "true" || v == "1" || v == "yes"
	}

	// Requests / ARR integration
	if v := os.Getenv("REQUESTS_ENABLED"); v != "" {
		cfg.Requests.Enabled = v == "true" || v == "1" || v == "yes"
	}
	if v := os.Getenv("RADARR_URL"); v != "" {
		cfg.Requests.Radarr.URL = v
	}
	if v := os.Getenv("RADARR_API_KEY"); v != "" {
		cfg.Requests.Radarr.APIKey = v
	}
	if v := os.Getenv("RADARR_4K_URL"); v != "" {
		cfg.Requests.Radarr4K.URL = v
	}
	if v := os.Getenv("RADARR_4K_API_KEY"); v != "" {
		cfg.Requests.Radarr4K.APIKey = v
	}
	if v := os.Getenv("SONARR_URL"); v != "" {
		cfg.Requests.Sonarr.URL = v
	}
	if v := os.Getenv("SONARR_API_KEY"); v != "" {
		cfg.Requests.Sonarr.APIKey = v
	}
	if v := os.Getenv("SONARR_4K_URL"); v != "" {
		cfg.Requests.Sonarr4K.URL = v
	}
	if v := os.Getenv("SONARR_4K_API_KEY"); v != "" {
		cfg.Requests.Sonarr4K.APIKey = v
	}

	// LLM / semantic search — see internal/llm and internal/embedding.
	if v := os.Getenv("LLM_ENABLED"); v != "" {
		cfg.LLM.Enabled = v == "true" || v == "1" || v == "yes"
	}
	// Provider selection + hosted-provider credentials. The historical Ollama
	// Cloud bearer (llm_api_key) is DB-only; these get env vars so an env-only
	// deployment can run a hosted provider without ever opening the admin UI.
	if v := os.Getenv("LLM_PROVIDER"); v != "" {
		cfg.LLM.Provider = v
	}
	if v := os.Getenv("LLM_EMBED_PROVIDER"); v != "" {
		cfg.LLM.EmbedProvider = v
	}
	if v := os.Getenv("LLM_ANTHROPIC_API_KEY"); v != "" {
		cfg.LLM.AnthropicAPIKey = v
	}
	if v := os.Getenv("LLM_OPENAI_API_KEY"); v != "" {
		cfg.LLM.OpenAIAPIKey = v
	}
	if v := os.Getenv("LLM_ANTHROPIC_BASE_URL"); v != "" {
		cfg.LLM.AnthropicBaseURL = v
	}
	if v := os.Getenv("LLM_OPENAI_BASE_URL"); v != "" {
		cfg.LLM.OpenAIBaseURL = v
	}
	if v := os.Getenv("LLM_OLLAMA_URL"); v != "" {
		cfg.LLM.OllamaURL = v
	}
	if v := os.Getenv("LLM_EMBED_MODEL"); v != "" {
		cfg.LLM.EmbedModel = v
	}
	if v := os.Getenv("LLM_CHAT_MODEL"); v != "" {
		cfg.LLM.ChatModel = v
	}
	if v := os.Getenv("LLM_EMBED_DIMS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			cfg.LLM.EmbedDims = i
		}
	}
	if v := os.Getenv("LLM_BACKFILL_WORKERS"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			cfg.LLM.BackfillWorkers = i
		}
	}
	if v := os.Getenv("LLM_BACKFILL_BATCH"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			cfg.LLM.BackfillBatch = i
		}
	}
	if v := os.Getenv("LLM_HTTP_TIMEOUT_SEC"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			cfg.LLM.HTTPTimeout = time.Duration(i) * time.Second
		}
	}
	if v := os.Getenv("LLM_NUM_CTX"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			cfg.LLM.NumCtx = i
		}
	}
	// AI matcher (internal/matching). Env-only, matching the
	// MATCH_AUTO_THRESHOLD precedent — operators tune via Docker env vars,
	// not the admin UI. Adding to the settings table is one line in
	// applyLLMOverrides if a future need arises.
	if v := os.Getenv("AI_MATCH_AUTO_THRESHOLD"); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 && i <= 100 {
			cfg.LLM.AIMatchAutoThreshold = i
		}
	}
	if v := os.Getenv("AI_MATCH_RATE_PER_SEC"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			cfg.LLM.AIMatchRatePerSec = f
		}
	}

	// M8 — voice ICE servers. STUN list is comma-separated. TURN URL is
	// a single string (coturn typically). All four are optional; defaults
	// already have Google's public STUN. Operators deploying coturn
	// populate AURORA_TURN_URL + AURORA_TURN_USERNAME + AURORA_TURN_CREDENTIAL
	// to enable cross-NAT calls. See docs/watchparty-progress.md M8.
	if v := os.Getenv("AURORA_VOICE_STUN_SERVERS"); v != "" {
		parts := strings.Split(v, ",")
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if t := strings.TrimSpace(p); t != "" {
				out = append(out, t)
			}
		}
		if len(out) > 0 {
			cfg.WatchParty.VoiceSTUNServers = out
		}
	}
	if v := os.Getenv("AURORA_TURN_URL"); v != "" {
		cfg.WatchParty.VoiceTURNURL = v
	}
	if v := os.Getenv("AURORA_TURN_USERNAME"); v != "" {
		cfg.WatchParty.VoiceTURNUsername = v
	}
	if v := os.Getenv("AURORA_TURN_CREDENTIAL"); v != "" {
		cfg.WatchParty.VoiceTURNCredential = v
	}

	// Bug-report feature (in-app "Report a Bug" → creates GitHub issue).
	// Off by default; operators opt in by setting all four env vars.
	// Missing GITHUB_TOKEN / GITHUB_REPO / PUBLIC_BASE_URL while
	// BUG_REPORT_ENABLED=true is a misconfiguration — handlers return
	// 503 with a clear message rather than panicking, so the operator
	// sees the problem on first submission attempt.
	if v := os.Getenv("BUG_REPORT_ENABLED"); v != "" {
		cfg.BugReport.Enabled = v == "true" || v == "1" || v == "yes"
	}
	// TrimSpace, not cleanBaseURL: these fail the same way (systemd keeps
	// whatever follows the `=`) with a worse symptom — an opaque 401 or 404
	// from GitHub that says nothing about the config — but a `#` is legal
	// inside neither a token nor an owner/repo, so cutting at one would be
	// inventing a rule where trimming is enough. A stray space is the shape
	// this actually takes, and it is what the shell would have dropped.
	if v := os.Getenv("BUG_REPORT_GITHUB_TOKEN"); v != "" {
		cfg.BugReport.GitHubToken = strings.TrimSpace(v)
	}
	if v := os.Getenv("BUG_REPORT_GITHUB_REPO"); v != "" {
		cfg.BugReport.GitHubRepo = strings.TrimSpace(v)
	}
	if v := os.Getenv("BUG_REPORT_PUBLIC_BASE_URL"); v != "" {
		// Trim space, cut an inline comment systemd would have kept, and strip
		// the trailing slash — see cleanBaseURL for why the comment cut is not
		// paranoia.
		trimmed, cutComment := cleanBaseURL(v)
		cfg.BugReport.PublicBaseURL = trimmed
		// The value is now usable, and that is exactly why this must be said
		// out loud. Cleaning silently would leave the broken line in
		// /etc/aurora/aurora.env — where install.sh preserves it verbatim
		// across every re-install — and make the deployment depend on this
		// function forever, which is the original silent-acceptance failure
		// moved one layer down rather than fixed.
		if cutComment {
			slog.Warn("BUG_REPORT_PUBLIC_BASE_URL had an inline comment, which was stripped — fix the env file",
				"used", trimmed,
				"raw", v,
				"hint", "systemd EnvironmentFile= does not support inline # comments; put the comment on its own line in /etc/aurora/aurora.env")
		}
		// 2026-05-27 (holistic deep-debug M3) — warn on suspicious
		// values at startup so the operator sees the misconfig
		// immediately instead of discovering broken issue-body
		// image previews later. Scheme must be http or https; host
		// must not be loopback because GitHub's image proxy can't
		// reach those.
		// Structural check FIRST, because the scheme switch below cannot see
		// this class of problem: `https://aurora.example.com   # comment`
		// starts with https:// and so took the happy path in silence, which is
		// how a malformed value survived months of filed issues without
		// logging anything at all. Reported as an error rather than a warning:
		// unlike the advisories below, a value that fails here cannot produce
		// a working attachment link under any circumstances.
		if complaint := baseURLComplaint(trimmed); complaint != "" {
			// The systemd hint only rides along when a comment is plausibly
			// implicated. Attaching it unconditionally told an operator who
			// deliberately typed a fragment to go move a comment that does not
			// exist — misdirection on the one line meant to be actionable.
			args := []any{"url", trimmed, "raw", v}
			if cutComment || strings.Contains(v, " #") || strings.Contains(v, "\t#") {
				args = append(args, "hint",
					"systemd EnvironmentFile= does not support inline # comments — put comments on their own line")
			}
			slog.Error("BUG_REPORT_PUBLIC_BASE_URL "+complaint, args...)
		}
		lower := strings.ToLower(trimmed)
		switch {
		case strings.HasPrefix(lower, "http://"):
			slog.Warn("BUG_REPORT_PUBLIC_BASE_URL uses HTTP — issue body image URLs will be HTTP forever, even if you upgrade to HTTPS later",
				"url", trimmed)
		case strings.HasPrefix(lower, "https://"):
			// happy path
		default:
			slog.Warn("BUG_REPORT_PUBLIC_BASE_URL is missing a scheme (expected http:// or https://) — attachment URLs will be malformed",
				"url", trimmed)
		}
		if strings.Contains(lower, "://localhost") ||
			strings.Contains(lower, "://127.") ||
			strings.Contains(lower, "://[::1]") ||
			strings.Contains(lower, "://0.0.0.0") {
			slog.Warn("BUG_REPORT_PUBLIC_BASE_URL points to a loopback / private address — GitHub's image proxy can't fetch attachments from there",
				"url", trimmed,
				"hint", "set this to your externally-reachable Aurora URL")
		}
	}
	// 2026-05-27 — Operational tunables for the bug-report feature.
	// All optional; each leaves the field at zero (= use default
	// downstream) when unset. Parsed as integers in plain units
	// (count, hours, days) so the env-var values are operator-friendly.
	//
	// Deep-debug #1/#2/#3 — each input is range-checked against a
	// sane upper bound. The bounds protect against:
	//   - time.Duration overflow when the int is multiplied by a
	//     unit constant (time.Duration is int64 nanoseconds; the
	//     multiplication overflows around ~292 years' worth of any
	//     unit). Negative-overflow values would silently fall back
	//     to defaults without operator notice.
	//   - memory bombs (RATE_LIMIT_MAX=1_000_000 → ~24 MB per
	//     limiter call × 10k user cap = real DoS surface).
	// Out-of-range values WARN + skip; same observability as
	// non-positive values.
	const (
		maxRateLimitMax    = 10_000   // 10k submits/window is absurd but caps the per-user-slice memory
		maxRateLimitWindow = 24 * 7   // 1 week
		maxAttachmentTTL   = 365 * 10 // 10 years (operator opts in to compliance-grade retention)
		maxJanitorInterval = 24 * 7   // 1 week
	)
	if v := os.Getenv("BUG_REPORT_RATE_LIMIT_MAX"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= maxRateLimitMax {
			cfg.BugReport.RateLimitMax = n
		} else {
			slog.Warn("BUG_REPORT_RATE_LIMIT_MAX must be a positive integer ≤ "+strconv.Itoa(maxRateLimitMax), "value", v)
		}
	}
	if v := os.Getenv("BUG_REPORT_RATE_LIMIT_WINDOW_HOURS"); v != "" {
		if h, err := strconv.Atoi(v); err == nil && h > 0 && h <= maxRateLimitWindow {
			cfg.BugReport.RateLimitWindow = time.Duration(h) * time.Hour
		} else {
			slog.Warn("BUG_REPORT_RATE_LIMIT_WINDOW_HOURS must be a positive integer (hours) ≤ "+strconv.Itoa(maxRateLimitWindow), "value", v)
		}
	}
	if v := os.Getenv("BUG_REPORT_ATTACHMENT_TTL_DAYS"); v != "" {
		if d, err := strconv.Atoi(v); err == nil && d > 0 && d <= maxAttachmentTTL {
			cfg.BugReport.AttachmentTTL = time.Duration(d) * 24 * time.Hour
		} else {
			slog.Warn("BUG_REPORT_ATTACHMENT_TTL_DAYS must be a positive integer (days) ≤ "+strconv.Itoa(maxAttachmentTTL), "value", v)
		}
	}
	if v := os.Getenv("BUG_REPORT_JANITOR_INTERVAL_HOURS"); v != "" {
		if h, err := strconv.Atoi(v); err == nil && h > 0 && h <= maxJanitorInterval {
			cfg.BugReport.JanitorSweepInterval = time.Duration(h) * time.Hour
		} else {
			slog.Warn("BUG_REPORT_JANITOR_INTERVAL_HOURS must be a positive integer (hours) ≤ "+strconv.Itoa(maxJanitorInterval), "value", v)
		}
	}
}

func (c *Config) ServerAddr() string {
	return fmt.Sprintf("%s:%d", c.Server.Host, c.Server.Port)
}

// DisplayHost returns a host string suitable for showing to humans
// in startup banners — i.e. something they can paste into a browser
// address bar. When the server is bound to a wildcard (0.0.0.0 or
// ::), browsers refuse those as DESTINATION addresses (Chrome ≥128
// blocks 0.0.0.0 entirely under the Private Network Access
// mitigations; Safari/Firefox treat it as invalid). Substitute
// "localhost" so the banner URL is clickable on the same machine.
// Operators on other machines reach the server via its LAN IP /
// hostname / configured TLS domain — none of which this affects,
// since DisplayHost only rewrites the wildcard cases.
//
// The actual bind address (returned by ServerAddr) is unchanged:
// the listener still accepts on all interfaces.
func (c *Config) DisplayHost() string {
	h := c.Server.Host
	switch h {
	case "", "0.0.0.0", "::", "[::]":
		return "localhost"
	}
	return h
}

// DisplayAddr is the host:port form of DisplayHost, suitable for
// composing user-facing URLs printed at startup.
func (c *Config) DisplayAddr() string {
	return fmt.Sprintf("%s:%d", c.DisplayHost(), c.Server.Port)
}

// cleanBaseURL normalizes an operator-supplied base URL from the environment.
//
// The comment cut is the load-bearing part, and it exists because the readers
// of /etc/aurora/aurora.env disagree about what a value IS. systemd's
// EnvironmentFile= (scripts/aurora.service) has NO inline-comment support: it
// strips trailing whitespace and keeps everything else, so
//
//	BUG_REPORT_PUBLIC_BASE_URL=https://aurora.example.com   # no trailing slash
//
// reaches this process with the comment attached. The shell does NOT keep it,
// and scripts/aurora-update.sh sources the same file with `set -a; . file`, so
// an operator debugging by sourcing sees a clean value while the server does
// not.
// That mismatch produced months of dead attachment links in filed issues
// before anyone looked at a rendered one.
//
// The `#` must be preceded by whitespace to count as a comment — the same rule
// dotenv parsers use — so a bare `#` inside a legitimate value (a fragment, a
// path segment) survives. Trailing-slash stripping is kept here rather than
// left at the call site: this is now the single normalization for the value,
// not a second one beside it.
//
// The second return reports whether a comment was actually cut, because
// cleaning silently would only move the original failure down a layer: the bad
// line stays in /etc/aurora/aurora.env, install.sh carries it forward verbatim
// on every re-install, and anything else reading it with systemd's semantics
// still gets the comment. The operator has to be told.
func cleanBaseURL(raw string) (string, bool) {
	v := strings.TrimSpace(raw)
	cut := false
	// Tracked as runes rather than by byte index: U+00A0 and friends are
	// multi-byte, and a non-breaking space is exactly what a value pasted from
	// a rendered doc or a browser address bar carries.
	prev := rune(-1)
	for i, r := range v {
		if r == '#' && prev >= 0 && unicode.IsSpace(prev) {
			v = v[:i]
			cut = true
			break
		}
		prev = r
	}
	return strings.TrimRight(strings.TrimSpace(v), "/"), cut
}

// baseURLComplaint returns a human-readable reason the cleaned base URL is
// unusable, or "" when it looks sound. Split out from the warn switch so the
// structural checks (parseable, has a host, no embedded whitespace) are
// testable without capturing log output.
//
// Whitespace AFTER cleaning is the interesting case: it means the value held
// something the comment cut did not explain away, which is exactly the shape
// the systemd/shell mismatch produces.
func baseURLComplaint(cleaned string) string {
	if strings.IndexFunc(cleaned, unicode.IsSpace) >= 0 {
		return "contains whitespace — attachment URLs built from it will be malformed"
	}
	u, err := url.Parse(cleaned)
	if err != nil {
		return "is not a parseable URL: " + err.Error()
	}
	if u.Host == "" {
		return "has no host"
	}
	// A `#` or `?` anywhere in a BASE url is silently fatal, which is why it is
	// named here rather than stripped. Composition appends the attachment path,
	// so `https://host/base#frag` becomes
	// `https://host/base#frag/api/feedback/attachments/x.png` — everything from
	// the `#` on is never sent to the server, and GitHub's image proxy fetches
	// `https://host/base` instead. A dead link, with nothing to show for it.
	//
	// Scanned as characters, NOT via u.Fragment/u.RawQuery, because those are
	// empty for a TRAILING delimiter: `https://host/#` parses with Fragment ""
	// and would pass, while composing to `https://host/#/api/...` — the whole
	// attachment path swallowed into a fragment, fetching `https://host/`.
	// Worse, cleanBaseURL's trailing-slash strip can CREATE that state, turning
	// the detectable `https://host/#/` into the undetectable `https://host/#`.
	//
	// This deliberately does NOT make cleanBaseURL strip fragments: a `#` that
	// survives the comment cut is one the operator meant, and truncating it
	// would be guessing. Saying so is the correct response.
	if strings.ContainsAny(cleaned, "#?") {
		return "carries a fragment or query string — everything after it is dropped from attachment links"
	}
	return ""
}

func parseOrigins(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	origins := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			origins = append(origins, p)
		}
	}
	return origins
}

// parseTrustedProxies splits the CIDR list and normalizes bare IPs into
// single-host CIDRs, so "127.0.0.1" works as well as "127.0.0.1/32".
//
// Being lenient here matters: a bare IP is the shape an operator will
// naturally write, and silently ignoring it would leave the rate limiter
// degraded while the config LOOKS correct — the worst failure mode for a
// security control. Genuinely malformed entries are dropped by the CIDR
// parser downstream (ParseTrustedProxyCIDRs), which logs them.
func parseTrustedProxies(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if !strings.Contains(p, "/") {
			if strings.Contains(p, ":") {
				p += "/128" // IPv6 single host
			} else {
				p += "/32" // IPv4 single host
			}
		}
		out = append(out, p)
	}
	return out
}

func splitCSV(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// ParseLogLevel converts a log level string (debug, info, warn, error) to a slog.Level.
// Defaults to slog.LevelInfo for unrecognized values.
func ParseLogLevel(level string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func (c *Config) OriginAllowed(origin string) bool {
	if origin == "" {
		return false
	}
	for _, allowed := range c.Server.AllowedOrigins {
		if allowed == "*" {
			return true
		}
		if strings.HasSuffix(allowed, ":*") {
			prefix := strings.TrimSuffix(allowed, "*")
			if strings.HasPrefix(origin, prefix) {
				// Validate that the remainder after the prefix is purely numeric
				// (a port number), not an arbitrary hostname like "localhost:evil.com".
				portPart := origin[len(prefix):]
				if _, err := strconv.Atoi(portPart); err == nil {
					return true
				}
			}
		}
		if allowed == origin {
			return true
		}
	}
	return false
}
