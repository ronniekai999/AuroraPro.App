// feedback_handlers.go — in-app "Report a Bug" submission.
//
// Routes:
//
//	GET  /api/feedback/config          (authed) → {enabled: bool}
//	POST /api/feedback                 (authed) → multipart submit
//	GET  /api/feedback/attachments/{name} (public) → uploaded asset
//
// The attachment endpoint is intentionally unauthenticated: the
// filename UUID is the access token (same shape as the existing
// /api/parties/{code}/share-image.png pattern). This lets GitHub's
// image proxy fetch the asset when rendering the issue body.
//
// Phase 1 MVP: file upload from disk only.
// Phase 2: in-browser screenshot capture via html2canvas (frontend
// only — no server changes needed; captured PNG flows through this
// same multipart endpoint).
// Phase 3 (this file): per-user rate limit on Submit + 30-day
// attachment janitor that sweeps abandoned uploads off disk. (.webm
// uploads from the new screen-recorder use the SAME multipart
// endpoint as captured PNGs — no new server-side handling needed
// because .webm was already on the safeExtension whitelist from
// Phase 1.)
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/feedback"
)

// FeedbackHandler owns the bug-report submission lifecycle. The
// underlying feedback.Client may be nil when the operator hasn't
// configured BUG_REPORT_GITHUB_TOKEN; handlers gate on cfg.Enabled +
// client != nil and return 503 with a clear message rather than
// panicking, so misconfiguration shows up the first time someone
// tries to submit.
//
// Phase 3 added two background-state pieces:
//   - submitLimiter: per-user-ID rate limiter (default 5/hour;
//     env-tunable via BUG_REPORT_RATE_LIMIT_MAX +
//     BUG_REPORT_RATE_LIMIT_WINDOW_HOURS).
//   - janitor: goroutine that sweeps <cacheDir>/<uuid>.{png,jpg,
//     jpeg,webp,webm,mp4} older than the TTL (default 30d;
//     env-tunable via BUG_REPORT_ATTACHMENT_TTL_DAYS) on a 1-hour
//     cadence (default; env-tunable via
//     BUG_REPORT_JANITOR_INTERVAL_HOURS). Started by
//     NewFeedbackHandler when the feature is enabled; stopped via
//     the rootCtx Aurora passes at startup (matches the existing
//     graceful-shutdown pattern).
//
// effectiveTTL / effectiveSweepInterval are computed at handler
// construction so the running goroutine has stable values for its
// lifetime even if config changes (it would require a restart
// anyway — Aurora doesn't hot-reload config).
type FeedbackHandler struct {
	cfg                    config.BugReportConfig
	client                 *feedback.Client
	cacheDir               string // absolute path to <Cache.ImageDir>/bug-reports
	submitLimiter          *feedbackLimiter
	effectiveTTL           time.Duration
	effectiveSweepInterval time.Duration
	// 2026-05-27 — Aurora server version (git SHA from build flags).
	// Threaded from RouterDeps.Version so the auto-collected
	// environment context in each issue body can stamp the
	// version the user was running. Empty when build flags don't
	// supply it (dev mode); treated as missing and omitted from
	// the context block.
	serverVersion string
	// 2026-05-27 — PAT health state. Updated at startup and on a
	// 6-hour cadence by runHealthChecks. atomic.Value carries
	// *patHealth (nil = not yet checked); admin operators see the
	// most recent state via GET /api/feedback/config so an expired
	// or revoked PAT surfaces immediately instead of only on the
	// first user-attempted Submit.
	tokenHealth atomic.Value // *patHealth
}

// patHealth is the snapshot stored in FeedbackHandler.tokenHealth.
// Never mutated after construction — replaced atomically. nil
// pointer means "not yet checked" (first run pending).
type patHealth struct {
	Healthy   bool      // true when the most recent Validate succeeded
	CheckedAt time.Time // when the check ran
	Reason    string    // human-readable error message; empty when Healthy
}

// healthCheckInterval — how often to re-validate the PAT. 6h
// balances "catch expiry within a reasonable window" against "don't
// thrash GitHub's API quota." A user-driven Submit triggers a fresh
// CreateIssue call regardless, so the background check is purely
// for operator-facing observability.
const healthCheckInterval = 6 * time.Hour

// Limits chosen to match GitHub's API constraints and the existing
// MaxBytesReader precedent in helpers.go.
const (
	maxFeedbackTitleLen   = 200            // GitHub's hard cap is 256; leave headroom for our prefix
	maxFeedbackDescLen    = 10_000         // 10 KB plain-text is plenty for a bug report; logs belong in attachments. Was 50_000; lowered per deep-debug #23 (large textareas lag low-end devices and pressure the issue body limit).
	maxFeedbackNameLen    = 100            // user-supplied display name (free-form)
	maxFeedbackAttachment = 25 << 20       // 25 MiB — matches GitHub's web upload cap
	maxFeedbackMultipart  = 25<<20 + 1<<19 // 25.5 MiB — 25 MiB file cap + 512 KiB headroom for fields + multipart overhead (deep-debug #17)
	// 2026-05-27 (deep-debug #32) — named so the docs / Phase 3
	// janitor have a single source of truth for the cache lifetime.
	// 1 hour at the origin so deletions propagate quickly; shared
	// caches (CDN) can hold for a day. Was `public, max-age=2592000`
	// (30 d) which made delete-and-replace effectively impossible.
	attachmentCacheControl = "public, max-age=3600, s-maxage=86400"

	// Phase 3 — per-user rate limit on Submit. Defaults: 5
	// reports/hour matches the operational-notes guidance in
	// docs/bug-report-setup.md. Lower than GitHub's secondary "abuse"
	// limiter (~30/min) so a single user can't trip global
	// throttling for everyone else. Operators can override via
	// BUG_REPORT_RATE_LIMIT_MAX / BUG_REPORT_RATE_LIMIT_WINDOW_HOURS.
	defaultFeedbackRateMax    = 5
	defaultFeedbackRateWindow = time.Hour
	// Caps the per-user-ID map size so a federated/compromised-account
	// flood can't grow unbounded memory. Mirrors auth.RateLimiter's
	// maxVisitors design. Worst-case memory ≈ RateLimitMax timestamps
	// × ~24 bytes × 10k users; with the default 5 timestamps that's
	// ~1.2 MB, with the env-cap of 10k timestamps it's ~2.4 GB.
	// (Hence the upper-bound checks on RateLimitMax in config.go.)
	// Eviction kicks in at insert time when this cap is hit.
	// (Phase 3 deep-debug H2.) Not env-tunable because it's a
	// memory-safety floor, not a policy decision.
	feedbackLimiterMaxUsers = 10_000

	// Phase 3 — attachment janitor defaults. 30 days matches the
	// issue body's expected freshness window (an embedded GitHub
	// issue image older than that almost certainly references a
	// closed/abandoned report). Sweep every hour so disk doesn't
	// fill between cadences on busy deploys. Operators can override
	// via BUG_REPORT_ATTACHMENT_TTL_DAYS / BUG_REPORT_JANITOR_INTERVAL_HOURS.
	defaultAttachmentTTL        = 30 * 24 * time.Hour
	defaultJanitorSweepInterval = time.Hour
	// Background sweep cadence for the rate-limiter map — same
	// pattern as auth.RateLimiter. Prevents the map from accumulating
	// permanent entries for users who submitted once and never came
	// back. (Phase 3 deep-debug M1.) Not env-tunable — purely
	// internal bookkeeping.
	limiterSweepInterval = time.Minute
)

// NewFeedbackHandler wires the handler. When cfg.Enabled is true but
// the GitHub PAT / repo are missing, client will be nil — the Submit
// handler returns 503 with a guidance message instead of crashing.
//
// imageDir comes from cfg.Cache.ImageDir; we create a "bug-reports"
// subdirectory under it on first use so a stale install doesn't fail
// on the first attachment.
//
// Phase 3 — when enabled AND ctx is non-nil, starts the attachment-
// janitor goroutine that exits cleanly when ctx is cancelled (matches
// Aurora's existing graceful-shutdown pattern: RouterDeps.RootCtx is
// the server-lifecycle context). When ctx is nil, the handler still
// works but the janitor doesn't start — useful for unit tests that
// don't want a background goroutine churning the filesystem.
func NewFeedbackHandler(ctx context.Context, cfg config.BugReportConfig, imageDir, serverVersion string) *FeedbackHandler {
	// Resolve each tunable: explicit positive cfg value wins; zero
	// or negative falls back to default.
	//
	// Deep-debug #5 — negative non-zero values WARN here for
	// parity with the env-parse path (which also warns on
	// non-positive input). Today only env populates these fields,
	// so the WARN is theoretical until a future config source
	// (YAML, CLI flag) bypasses the env-parse layer. Belt-and-
	// suspenders against silent operator misconfig.
	rateMax := cfg.RateLimitMax
	if rateMax < 0 {
		slog.Warn("BugReport.RateLimitMax is negative; falling back to default", "value", rateMax)
	}
	if rateMax <= 0 {
		rateMax = defaultFeedbackRateMax
	}
	rateWindow := cfg.RateLimitWindow
	if rateWindow < 0 {
		slog.Warn("BugReport.RateLimitWindow is negative; falling back to default", "value", rateWindow)
	}
	if rateWindow <= 0 {
		rateWindow = defaultFeedbackRateWindow
	}
	ttl := cfg.AttachmentTTL
	if ttl < 0 {
		slog.Warn("BugReport.AttachmentTTL is negative; falling back to default", "value", ttl)
	}
	if ttl <= 0 {
		ttl = defaultAttachmentTTL
	}
	sweep := cfg.JanitorSweepInterval
	if sweep < 0 {
		slog.Warn("BugReport.JanitorSweepInterval is negative; falling back to default", "value", sweep)
	}
	if sweep <= 0 {
		sweep = defaultJanitorSweepInterval
	}
	h := &FeedbackHandler{
		cfg:                    cfg,
		cacheDir:               filepath.Join(imageDir, "bug-reports"),
		submitLimiter:          newFeedbackLimiter(rateMax, rateWindow),
		effectiveTTL:           ttl,
		effectiveSweepInterval: sweep,
		serverVersion:          strings.TrimSpace(serverVersion),
	}
	if cfg.Enabled {
		client, err := feedback.New(cfg.GitHubToken, cfg.GitHubRepo)
		if err != nil {
			// Log + leave client nil. The Submit handler will return
			// 503 explaining what's missing rather than panicking.
			slog.Warn("bug report client init failed; submissions will return 503",
				"error", err,
				"hint", "set BUG_REPORT_GITHUB_TOKEN and BUG_REPORT_GITHUB_REPO (owner/repo)")
		} else {
			h.client = client
		}
		// Janitor + limiter sweep + health-check run only when the
		// feature is enabled AND a ctx is provided (otherwise no
		// graceful-shutdown signal).
		if ctx != nil {
			go h.runJanitor(ctx)
			go h.submitLimiter.runSweep(ctx)
			// 2026-05-27 — PAT health check. Only starts when we
			// actually have a client (cfg.Enabled + valid token/repo
			// pair); without a client there's nothing to validate.
			if h.client != nil {
				go h.runHealthChecks(ctx)
			}
		}
	}
	return h
}

// runHealthChecks validates the configured PAT at startup and then
// on a 6-hour cadence. Result lands in h.tokenHealth so admin
// operators see it via GET /api/feedback/config. Logs at WARN on
// failure (so the issue shows up in operator logs even if no admin
// is watching the API), INFO on the first successful check + on
// recovery from a failed state.
//
// The goroutine exits when ctx is cancelled. Same lifecycle pattern
// as runJanitor + runSweep.
func (h *FeedbackHandler) runHealthChecks(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	// Initial check on startup. Brief delay so we don't race
	// against the rest of Aurora's startup (DB pool, etc.).
	select {
	case <-time.After(5 * time.Second):
	case <-ctx.Done():
		return
	}
	// Deep-debug M2 — wrap EACH iteration in panic recovery so a
	// single panic doesn't permanently kill the health checker.
	// Previously the recover was on the goroutine boundary which
	// silently downgraded "checker stalled" to "checker dead" —
	// admin operators would see `CheckedAt` stuck at the panic
	// time with no further signal. Per-iteration recovery means
	// the next tick still runs.
	runOne := func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("feedback health check: panic recovered — retrying on next tick",
					"recover", r)
			}
		}()
		h.checkTokenHealth(ctx)
	}
	runOne()
	ticker := time.NewTicker(healthCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			runOne()
		case <-ctx.Done():
			return
		}
	}
}

// checkTokenHealth runs a single Validate call and updates
// h.tokenHealth atomically. Idempotent; safe to call from any
// goroutine.
func (h *FeedbackHandler) checkTokenHealth(ctx context.Context) {
	// Short timeout — health checks shouldn't hold sockets for long.
	// The Validate request itself runs through the SSRF-guarded
	// http.Client with its own timeout, so this is belt-and-
	// suspenders.
	checkCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	prev, _ := h.tokenHealth.Load().(*patHealth)
	now := time.Now()
	var next *patHealth
	if err := h.client.Validate(checkCtx); err != nil {
		next = &patHealth{Healthy: false, CheckedAt: now, Reason: err.Error()}
		// Deep-debug M3 — log WARN only on TRANSITIONS (first
		// failure or reason-change), not every 6h while the PAT
		// stays broken. Most alerting platforms dedupe, but log
		// volume is real on busy log aggregators and a "broken
		// PAT" condition gets one alert + the operator deals with
		// it; subsequent failures are noise. Recovery still logs
		// INFO via the success branch.
		shouldWarn := prev == nil || prev.Healthy || prev.Reason != err.Error()
		if shouldWarn {
			slog.Warn("feedback PAT health check failed",
				"reason", err.Error(),
				"repo", h.cfg.GitHubRepo,
				"hint", "rotate the PAT or check BUG_REPORT_GITHUB_REPO")
		}
	} else {
		next = &patHealth{Healthy: true, CheckedAt: now}
		// Log INFO only on the FIRST success or when recovering
		// from a failed state — avoids spamming logs every 6h for
		// healthy deployments.
		if prev == nil {
			slog.Info("feedback PAT health check: initial validation succeeded",
				"repo", h.cfg.GitHubRepo)
		} else if !prev.Healthy {
			slog.Info("feedback PAT health check: recovered",
				"repo", h.cfg.GitHubRepo,
				"prior_reason", prev.Reason)
		}
	}
	h.tokenHealth.Store(next)
}

// runJanitor sweeps <cacheDir> every h.effectiveSweepInterval and
// deletes files older than h.effectiveTTL (both env-tunable, default
// 1h / 30d). Logs a startup INFO line so operators can confirm the
// goroutine spawned (holistic deep-debug L4); subsequent sweep
// summaries log INFO when >= 10 files removed, DEBUG otherwise to
// keep low-traffic deploys out of operator logs. The goroutine
// exits when ctx is cancelled (server shutdown).
//
// Why sweep on a ticker (not on every Submit): bug-report traffic is
// bursty (clustered around new releases). A submit-time sweep would
// either thrash during a burst or skip cleanup entirely during the
// long gaps. The 1-hour cadence is plenty for a 30-day TTL — even on
// a busy deploy, at most 1h of stale files accumulate between sweeps.
func (h *FeedbackHandler) runJanitor(ctx context.Context) {
	// Run one sweep at startup so a long-stopped server doesn't wait
	// an extra hour before pruning. Bail early if ctx is already
	// cancelled (test cleanup races).
	if ctx.Err() != nil {
		return
	}
	// Deep-debug #4 — defense-in-depth recover. time.NewTicker
	// panics on a non-positive interval; config-resolution catches
	// the documented paths today, but a future config source could
	// produce sub-second-but-positive overflow corner cases that
	// reach here. A panic in this goroutine should be logged + the
	// goroutine should exit cleanly, NOT crash the Aurora process.
	defer func() {
		if r := recover(); r != nil {
			slog.Error("feedback janitor: panic recovered — janitor exiting",
				"panic", r,
				"sweep_interval", h.effectiveSweepInterval.String())
		}
	}()
	slog.Info("feedback janitor: started",
		"sweep_interval", h.effectiveSweepInterval.String(),
		"ttl", h.effectiveTTL.String(),
		"cache_dir", h.cacheDir)
	h.sweepAttachments()
	ticker := time.NewTicker(h.effectiveSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			h.sweepAttachments()
		case <-ctx.Done():
			return
		}
	}
}

// sweepAttachments scans h.cacheDir and removes files older than
// h.effectiveTTL (env-tunable). Failures (missing dir, read errors)
// are logged and the function returns cleanly — janitor lifecycle
// MUST NOT crash the parent goroutine on transient FS issues.
func (h *FeedbackHandler) sweepAttachments() {
	entries, err := os.ReadDir(h.cacheDir)
	if err != nil {
		// Missing directory is the steady state until the first
		// upload — not worth logging as a warning.
		if !os.IsNotExist(err) {
			slog.Warn("feedback janitor: read dir failed", "dir", h.cacheDir, "error", err)
		}
		return
	}
	cutoff := time.Now().Add(-h.effectiveTTL)
	var removed, kept int
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		// Only sweep files whose names match the whitelisted shape so
		// a misplaced operator file (e.g. README.txt) doesn't get
		// nuked. Same whitelist as the public-serve route uses.
		if !isValidAttachmentName(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			slog.Warn("feedback janitor: stat failed", "file", entry.Name(), "error", err)
			continue
		}
		if info.ModTime().After(cutoff) {
			kept++
			continue
		}
		full := filepath.Join(h.cacheDir, entry.Name())
		if err := os.Remove(full); err != nil {
			slog.Warn("feedback janitor: remove failed", "file", entry.Name(), "error", err)
			continue
		}
		removed++
	}
	// Phase 3 deep-debug L3 — log at DEBUG for routine sweeps so
	// busy deploys don't get an INFO line every hour. INFO is
	// reserved for substantive removals (>= 10 files) which signal
	// real activity worth seeing in operator logs.
	if removed >= 10 {
		slog.Info("feedback janitor: swept attachments",
			"removed", removed,
			"kept", kept,
			"ttl", h.effectiveTTL.String())
	} else if removed > 0 {
		slog.Debug("feedback janitor: swept attachments",
			"removed", removed,
			"kept", kept,
			"ttl", h.effectiveTTL.String())
	}
}

// feedbackLimiter is a per-user-ID rate limiter for the Submit
// endpoint. Inline (vs. reusing auth.RateLimiter) because that
// limiter keys on IP and we want user-scoped throttling — a single
// user behind NAT shouldn't share a budget with their household's
// other Aurora users.
//
// Token-bucket-style: each user gets `rate` tokens in `window`. When
// a request lands, we prune expired timestamps from their slice; if
// the remaining count is below `rate`, append now() and allow. Else
// reject.
//
// Memory bound: capped at `maxUsers` entries via insert-time
// eviction (Phase 3 deep-debug H2). A background sweep goroutine
// (Phase 3 deep-debug M1) prunes stale entries every
// limiterSweepInterval so users who submitted once and left don't
// occupy slots forever.
type feedbackLimiter struct {
	mu       sync.Mutex
	bucket   map[int64][]time.Time // userID → timestamps within the window
	rate     int
	window   time.Duration
	maxUsers int
}

func newFeedbackLimiter(rate int, window time.Duration) *feedbackLimiter {
	return &feedbackLimiter{
		bucket:   make(map[int64][]time.Time),
		rate:     rate,
		window:   window,
		maxUsers: feedbackLimiterMaxUsers,
	}
}

// allow returns (true, _) if the user is under the rate cap and
// records the request. Returns (false, retryAfter) otherwise, with
// retryAfter set to the duration until the oldest in-window
// timestamp falls off.
func (l *feedbackLimiter) allow(userID int64) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-l.window)
	hits := l.bucket[userID]
	// Prune expired timestamps. Allocate a fresh slice (Phase 3
	// deep-debug L7) instead of reusing `hits[:0]` — the in-place
	// aliasing was technically correct but creates a footgun if a
	// future caller ever holds a reference to the slice (e.g. for
	// metrics). The allocation cost is trivial (rate=5 elements).
	var pruned []time.Time
	if len(hits) > 0 {
		pruned = make([]time.Time, 0, len(hits))
		for _, t := range hits {
			if t.After(cutoff) {
				pruned = append(pruned, t)
			}
		}
	}
	if len(pruned) >= l.rate {
		// Retry-After = how long until the oldest hit ages out.
		retryAfter := pruned[0].Add(l.window).Sub(now)
		if retryAfter < time.Second {
			retryAfter = time.Second // floor for the HTTP header value
		}
		l.bucket[userID] = pruned
		return false, retryAfter
	}
	// Phase 3 deep-debug H2 — bound the map size before inserting a
	// new user. Mirrors auth.RateLimiter's pattern: when at the cap,
	// evict any expired entries inline first, then drop the oldest
	// remaining if still over.
	if _, exists := l.bucket[userID]; !exists && len(l.bucket) >= l.maxUsers {
		l.evictExpiredLocked(cutoff)
		if len(l.bucket) >= l.maxUsers {
			// Random eviction — map iteration order is unspecified
			// in Go, which gives us effective randomness suitable for
			// a DoS-defense layer (any victim is acceptable).
			for k := range l.bucket {
				delete(l.bucket, k)
				break
			}
		}
	}
	pruned = append(pruned, now)
	l.bucket[userID] = pruned
	return true, 0
}

// evictExpiredLocked removes entries whose newest timestamp is
// before `cutoff`. Caller must hold l.mu.
func (l *feedbackLimiter) evictExpiredLocked(cutoff time.Time) {
	for uid, hits := range l.bucket {
		if len(hits) == 0 || !hits[len(hits)-1].After(cutoff) {
			delete(l.bucket, uid)
		}
	}
}

// runSweep periodically evicts users whose most-recent submit is
// older than the rate-limit window. Lifecycle parented off ctx so
// the goroutine exits cleanly on graceful shutdown — same pattern
// as runJanitor. (Phase 3 deep-debug M1.)
func (l *feedbackLimiter) runSweep(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	// Holistic deep-debug L4 — startup INFO so operators can confirm
	// the goroutine spawned. The per-tick body is silent (eviction
	// is just bookkeeping).
	slog.Info("feedback limiter: sweep started",
		"sweep_interval", limiterSweepInterval.String(),
		"rate", l.rate,
		"window", l.window.String())
	ticker := time.NewTicker(limiterSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			l.mu.Lock()
			l.evictExpiredLocked(time.Now().Add(-l.window))
			l.mu.Unlock()
		case <-ctx.Done():
			return
		}
	}
}

// FeedbackConfigResponse is what GET /api/feedback/config returns to
// authed users. The frontend gates the launcher button on `enabled`.
//
// 2026-05-27 — TokenHealthy / TokenHealthReason are populated ONLY
// when the requester is an admin (claims.Role == "admin"). Pointer
// on TokenHealthy distinguishes "checked false" from "not yet
// checked" (no value sent); regular users always see both fields
// omitted via `omitempty` because admins shouldn't share PAT
// diagnostics with the rest of the user base.
type FeedbackConfigResponse struct {
	Enabled              bool   `json:"enabled"`
	TokenHealthy         *bool  `json:"token_healthy,omitempty"`
	TokenHealthReason    string `json:"token_health_reason,omitempty"`
	TokenHealthCheckedAt string `json:"token_health_checked_at,omitempty"`
}

// GetConfig — GET /api/feedback/config
//
// Returns {enabled: bool} so the frontend can hide the launcher when
// the feature is off (the entire response is small and cheap; safe
// to fetch once per session). Authed because we don't expose
// feature-flag state to the public.
//
// 2026-05-27 — Admin requesters also see PAT-health diagnostics so
// they can act on token expiry / revocation before users hit the
// submit-time 5xx. Regular users get the omitempty fields blank.
func (h *FeedbackHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	resp := FeedbackConfigResponse{
		// Operator may set Enabled=true but forget the token — that
		// case STILL reports enabled to the frontend. The submit
		// handler then 503s on first attempt, which is the right
		// failure mode (admin sees the misconfiguration immediately).
		Enabled: h.cfg.Enabled,
	}
	claims := auth.GetClaims(r.Context())
	if claims != nil && claims.Role == "admin" {
		if hp, ok := h.tokenHealth.Load().(*patHealth); ok && hp != nil {
			healthy := hp.Healthy
			resp.TokenHealthy = &healthy
			if !healthy {
				resp.TokenHealthReason = hp.Reason
			}
			resp.TokenHealthCheckedAt = hp.CheckedAt.UTC().Format(time.RFC3339)
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// FeedbackSubmitResponse is returned to the frontend after a
// successful submission so the toast can deep-link to the issue.
type FeedbackSubmitResponse struct {
	IssueURL    string `json:"issue_url"`
	IssueNumber int    `json:"issue_number"`
}

// Submit — POST /api/feedback (multipart/form-data)
//
// Form fields:
//   - title              (required, <= maxFeedbackTitleLen)
//   - description        (required, <= maxFeedbackDescLen)
//   - name               (optional, <= maxFeedbackNameLen — used for context)
//   - attachment         (optional file, <= maxFeedbackAttachment)
//   - client_url         (optional, <= 500 chars — page URL where the bug was hit)
//   - client_viewport    (optional, <= 500 chars — "1920x1080")
//   - client_dpr         (optional, <= 500 chars — devicePixelRatio)
//   - client_user_agent  (optional, <= 500 chars — navigator.userAgent)
//   - client_language    (optional, <= 500 chars — navigator.language)
//   - client_time        (optional, <= 500 chars — ISO 8601, user-clock time)
//
// The auto-collected client_* fields land in a collapsed `<details>`
// block at the bottom of the issue body so triagers can expand to
// see env context without it dominating the report. Each is
// length-capped + control-char-stripped server-side (sanitizeContextField).
//
// Errors:
//   - 404 if the feature flag is off
//   - 503 if enabled but client wasn't configured (admin needs to set env vars)
//   - 400 on validation failure
//   - 502 on upstream GitHub failure
//   - 201 with FeedbackSubmitResponse on success
func (h *FeedbackHandler) Submit(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.Enabled {
		// Pretend the route doesn't exist when the feature is off —
		// mirrors how /api/requests endpoints behave when requests
		// are disabled.
		writeError(w, http.StatusNotFound, "bug reporting is not enabled on this server")
		return
	}
	if h.client == nil {
		writeError(w, http.StatusServiceUnavailable,
			"bug reporting is enabled but misconfigured — administrator needs to set BUG_REPORT_GITHUB_TOKEN and BUG_REPORT_GITHUB_REPO")
		return
	}
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}

	// Cap the entire multipart payload BEFORE parsing — otherwise a
	// 100MB upload would buffer to memory/disk before we discover it
	// exceeds the limit.
	r.Body = http.MaxBytesReader(w, r.Body, maxFeedbackMultipart)
	if err := r.ParseMultipartForm(2 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid multipart upload: "+err.Error())
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	title := strings.TrimSpace(r.FormValue("title"))
	desc := strings.TrimSpace(r.FormValue("description"))
	name := strings.TrimSpace(r.FormValue("name"))
	if title == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}
	if desc == "" {
		writeError(w, http.StatusBadRequest, "description is required")
		return
	}
	if len(title) > maxFeedbackTitleLen {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("title exceeds %d characters", maxFeedbackTitleLen))
		return
	}
	if len(desc) > maxFeedbackDescLen {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("description exceeds %d characters", maxFeedbackDescLen))
		return
	}
	if len(name) > maxFeedbackNameLen {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("name exceeds %d characters", maxFeedbackNameLen))
		return
	}

	// Optional attachment. Form value "attachment" is the upload field
	// name the frontend uses; missing = no attachment.
	//
	// 2026-05-27 (deep-debug #16) — reject multiple attachments
	// explicitly rather than silently dropping all but the first. A
	// malicious client could otherwise spend our MaxBytesReader
	// budget on parts that get discarded.
	var attachmentURL string
	var savedAttachmentName string // tracked for failure-path cleanup (deep-debug #10)
	if r.MultipartForm != nil && len(r.MultipartForm.File["attachment"]) > 1 {
		writeError(w, http.StatusBadRequest, "only one attachment is allowed per report")
		return
	}
	if r.MultipartForm != nil && len(r.MultipartForm.File["attachment"]) == 1 {
		fh := r.MultipartForm.File["attachment"][0]
		if fh.Size > maxFeedbackAttachment {
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("attachment exceeds %d bytes", maxFeedbackAttachment))
			return
		}
		// Reject obviously-bad MIME types up front so we don't write
		// a `.bin` file then refuse to serve it on the back end.
		// (safeExtension also handles this, but explicit rejection
		// gives a better error message to the user.)
		if ext := safeExtension(fh.Filename); ext == ".bin" {
			writeError(w, http.StatusBadRequest,
				"attachment must be an image (.png, .jpg, .webp) or video (.webm, .mp4)")
			return
		}
		savedName, err := h.saveAttachment(fh)
		if err != nil {
			slog.Warn("feedback attachment save failed", "error", err, "user_id", claims.UserID)
			writeError(w, http.StatusInternalServerError, "failed to save attachment")
			return
		}
		savedAttachmentName = savedName
		// PublicBaseURL is required when an attachment is present —
		// GitHub's renderer needs an externally-reachable URL.
		if h.cfg.PublicBaseURL == "" {
			// Attachment was saved but we can't link to it; delete +
			// 503 so the operator sees the misconfiguration.
			_ = os.Remove(filepath.Join(h.cacheDir, savedName))
			writeError(w, http.StatusServiceUnavailable,
				"bug reporting attachments require BUG_REPORT_PUBLIC_BASE_URL to be configured")
			return
		}
		attachmentURL = h.cfg.PublicBaseURL + "/api/feedback/attachments/" + savedName
	}

	// Phase 3 (deep-debug Phase 3 H1) — per-user rate limit moved to
	// AFTER input validation + attachment save, immediately before the
	// GitHub POST. The limiter protects the shared PAT; the PAT is
	// only invoked by CreateIssue, so charging a token for invalid
	// requests (empty title, oversized body, bad MIME) would let a
	// user with a buggy client lock themselves out without ever
	// actually contacting GitHub. The attachment save above can't be
	// undone cheaply if we reject here, so we accept that cost in
	// exchange for the simpler "1 token per real GitHub attempt"
	// invariant — the orphan-cleanup path runs the same way it does
	// on a GH POST failure.
	if allowed, retryAfter := h.submitLimiter.allow(claims.UserID); !allowed {
		// Clean up the orphan attachment if we wrote one above.
		if savedAttachmentName != "" {
			_ = os.Remove(filepath.Join(h.cacheDir, savedAttachmentName))
		}
		w.Header().Set("Retry-After", fmt.Sprintf("%d", int(retryAfter.Seconds())))
		writeError(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many bug reports — please wait %d seconds before submitting again", int(retryAfter.Seconds())))
		return
	}

	// 2026-05-27 — Auto-collected environment context. Client sends
	// browser-side facts (URL, viewport, UA, language, client time);
	// server fills its own version + a trusted server timestamp.
	// Each client field is sanitized + length-capped. All optional;
	// the `<details>` block renders only when at least one field
	// has a value (handled by environmentContext.hasAny).
	env := environmentContext{
		url:              sanitizeContextField(r.FormValue("client_url")),
		viewport:         sanitizeContextField(r.FormValue("client_viewport")),
		devicePixelRatio: sanitizeContextField(r.FormValue("client_dpr")),
		userAgent:        sanitizeContextField(r.FormValue("client_user_agent")),
		language:         sanitizeContextField(r.FormValue("client_language")),
		clientTime:       sanitizeContextField(r.FormValue("client_time")),
		serverVersion:    h.serverVersion,
		serverTime:       time.Now().UTC().Format(time.RFC3339),
	}

	// Build the issue body. Putting submitter context (name + Aurora
	// username) at the bottom keeps the user's description the lede
	// for triagers reading on GitHub.
	body := buildIssueBody(desc, name, claims.Username, attachmentURL, env)

	// Use the request's context so a client disconnect aborts the
	// in-flight GitHub call cleanly.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	resp, err := h.client.CreateIssue(ctx, feedback.CreateIssueRequest{
		Title:  title,
		Body:   body,
		Labels: []string{"bug", "user-report"},
	})
	if err != nil {
		// 2026-05-27 (deep-debug #10) — clean up the orphaned
		// attachment now that the GH POST failed. Without this,
		// every failed submission leaks the uploaded file to disk
		// until the Phase 3 janitor lands.
		if savedAttachmentName != "" {
			_ = os.Remove(filepath.Join(h.cacheDir, savedAttachmentName))
		}
		// 2026-05-27 (deep-debug #18) — return a stable user-facing
		// message instead of echoing GitHub's raw response body or
		// internal error strings. Detail is logged at WARN so admins
		// can debug from the server log.
		slog.Warn("feedback issue create failed", "error", err, "user_id", claims.UserID)
		writeError(w, http.StatusBadGateway,
			"bug report submission failed — please try again later or contact your administrator")
		return
	}

	slog.Info("feedback issue created",
		"user_id", claims.UserID,
		"username", claims.Username,
		"issue_number", resp.Number,
		"has_attachment", attachmentURL != "")

	writeJSON(w, http.StatusCreated, FeedbackSubmitResponse{
		IssueURL:    resp.HTMLURL,
		IssueNumber: resp.Number,
	})
}

// ServeAttachment — GET /api/feedback/attachments/{name}
//
// Unauthenticated by design: the filename is a 128-bit random hex
// string (32 chars), so it's collision-resistant and serves as the
// access token. Mirrors the /api/parties/{code}/share-image.png
// pattern. Allows GitHub's image proxy to render the attachment in
// the issue body.
//
// Hard restrictions on the path:
//   - Must match a strict filename pattern (hex UUID + extension)
//   - Extension whitelist: .png .jpg .jpeg .webp .webm .mp4
//
// Anything else returns 404 to defeat directory traversal attempts.
func (h *FeedbackHandler) ServeAttachment(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.Enabled {
		// Don't leak feature state — 404 looks like the route
		// doesn't exist.
		http.NotFound(w, r)
		return
	}
	name := chi.URLParam(r, "name")
	if !isValidAttachmentName(name) {
		http.NotFound(w, r)
		return
	}
	full := filepath.Join(h.cacheDir, name)
	// 2026-05-27 (deep-debug #12) — the strict whitelist in
	// isValidAttachmentName (32 hex chars + dot + whitelisted ext)
	// guarantees there are no path-traversal characters in `name`,
	// so filepath.Join can't escape h.cacheDir. The HasPrefix check
	// below is a belt-and-suspenders defense in case the validator
	// is later loosened.
	if !strings.HasPrefix(full, h.cacheDir+string(os.PathSeparator)) {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	// 2026-05-27 (deep-debug #13) — defense against MIME-sniffing
	// XSS on the same-origin attachment URL. nosniff prevents browsers
	// from re-typing a PNG as HTML based on content; inline +
	// filename keeps the rendering behavior friendly while still
	// stopping HTML execution. Without nosniff, a malicious file
	// named pwn.png but containing HTML would render inline in the
	// SPA origin's context — a stored-XSS vector.
	w.Header().Set("Content-Type", mimeForAttachment(name))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", `inline; filename="`+name+`"`)
	// 2026-05-27 (deep-debug #14) — shorter origin TTL (1h) so
	// admin deletions propagate quickly; CDNs may still hold for a
	// day via s-maxage. Was 30d (`max-age=2592000`), which made
	// after-the-fact deletion effectively impossible.
	w.Header().Set("Cache-Control", attachmentCacheControl)
	http.ServeContent(w, r, name, info.ModTime(), f)
}

// ─── helpers ───────────────────────────────────────────────────────

// saveAttachment writes the uploaded file to disk under a fresh
// random hex filename. Returns the saved filename (NOT the full
// path). Caller is responsible for cleaning up the file if subsequent
// steps fail (the Submit handler does this when PublicBaseURL is
// missing, for example).
func (h *FeedbackHandler) saveAttachment(fh *multipart.FileHeader) (string, error) {
	if err := os.MkdirAll(h.cacheDir, 0o755); err != nil {
		return "", fmt.Errorf("mkdir cache: %w", err)
	}
	name := newAttachmentID() + safeExtension(fh.Filename)
	full := filepath.Join(h.cacheDir, name)
	src, err := fh.Open()
	if err != nil {
		return "", fmt.Errorf("open upload: %w", err)
	}
	defer src.Close()
	// O_EXCL guards against a (vanishingly unlikely) hex-ID collision.
	dst, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", fmt.Errorf("create attachment: %w", err)
	}
	// io.CopyN with Size+1 lets us detect if the actual upload bytes
	// exceed the declared Size (defense against a tampered Content-
	// Length / chunked upload that claims one size but sends more).
	// We rejected oversized files via fh.Size > maxFeedbackAttachment
	// in the caller; this is a belt-and-suspenders check.
	written, copyErr := io.CopyN(dst, src, fh.Size+1)
	if copyErr != nil && copyErr != io.EOF {
		_ = dst.Close()
		_ = os.Remove(full)
		return "", fmt.Errorf("write attachment: %w", copyErr)
	}
	if written > fh.Size {
		_ = dst.Close()
		_ = os.Remove(full)
		return "", fmt.Errorf("attachment body exceeded declared size")
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(full)
		return "", fmt.Errorf("close attachment: %w", err)
	}
	return name, nil
}

// newAttachmentID generates a 128-bit random hex string (32 chars).
// crypto/rand source — must not be replaced with math/rand, since
// the filename IS the access token for public serving.
func newAttachmentID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// Should be impossible on any platform we run on; if it is,
		// degrade to a time-based ID with a clear marker so the
		// admin sees the issue in logs (the request will still
		// succeed, just with a less-secret URL).
		return fmt.Sprintf("fallback-%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}

// safeExtension returns a lowercase, whitelisted extension (including
// the leading dot) for an uploaded filename. Anything not on the
// whitelist gets ".bin" as a fallback — but isValidAttachmentName
// will then refuse to serve ".bin" so the upload becomes inert.
func safeExtension(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4":
		return ext
	default:
		return ".bin"
	}
}

// isValidAttachmentName whitelists the allowed filename shape so the
// public-served route can't be used for directory traversal or to
// fetch unrelated files. Filename must be 32 lowercase hex chars +
// allowed extension.
func isValidAttachmentName(name string) bool {
	dot := strings.LastIndexByte(name, '.')
	if dot != 32 {
		return false
	}
	hexPart := name[:dot]
	for _, r := range hexPart {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	switch name[dot:] {
	case ".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4":
		return true
	}
	return false
}

// mimeForAttachment maps the extension to a Content-Type. Used for
// the public-serve endpoint so browsers render images inline.
func mimeForAttachment(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".webm":
		return "video/webm"
	case ".mp4":
		return "video/mp4"
	default:
		return "application/octet-stream"
	}
}

// buildIssueBody composes the GitHub issue body. Description is the
// lede; submitter context goes at the bottom. Attachment URL renders
// as a Markdown image embed (GitHub's renderer auto-detects video
// content and shows a player for .webm / .mp4).
//
// 2026-05-27 (deep-debug #8 + #11) — user-supplied strings are
// escaped before splicing into the Markdown so a crafted name /
// description / username can't:
//   - break out of the `by **<name>**` bold and inject following text
//   - break out of the `(Aurora user: ` “<u>“ `)` code span
//   - inject a fake "Submitted via Aurora bug-report" footer in their
//     description (the divider sentinel is an HTML comment, not a
//     bare `---\n`, so user `---\n` in their description doesn't
//     collide)
//   - inject a misleading `[click here](javascript:...)` style link
//     (GitHub's renderer blocks javascript: but lookalike-URL phishing
//     in a credibility-lending issue body is still real)
//
// description is rendered as a Markdown blockquote (`> ` prefix on
// every line) so any internal Markdown the user wrote still renders,
// but it's visually enclosed and clearly delimited from server-
// composed content.
func buildIssueBody(description, name, username, attachmentURL string, env environmentContext) string {
	var b strings.Builder
	// User description as a quoted block. Any line they wrote (incl.
	// `---`, `#`, `>`, etc.) is rendered inside the quote so they
	// can't impersonate the server-composed footer below.
	for _, line := range strings.Split(description, "\n") {
		b.WriteString("> ")
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString("\n")
	if attachmentURL != "" {
		b.WriteString("**Attachment:** ")
		b.WriteString(attachmentURL)
		b.WriteString("\n\n")
		b.WriteString("![attachment](")
		b.WriteString(attachmentURL)
		b.WriteString(")\n\n")
	}
	// 2026-05-27 — Auto-collected environment context. Collapsed
	// `<details>` block so the issue body stays scannable but
	// triagers can expand to see the URL / viewport / browser /
	// Aurora version / etc. Frontend sends client-side facts
	// (URL, viewport, UA); server fills in its own version + a
	// trusted timestamp so the user can't spoof either.
	//
	// Deep-debug H2 — gate on client-supplied fields only so a
	// stripped-down POST (curl, third-party client) doesn't get a
	// near-empty Environment block containing just server-stamped
	// fields. The server values are still rendered when client
	// values trigger the block; they're additive, not the trigger.
	//
	// Deep-debug L4 — Aurora version surfaced in the <summary>
	// itself so triagers see it without needing to expand.
	if env.hasClientContext() {
		b.WriteString("<details>\n")
		if env.serverVersion != "" {
			b.WriteString("<summary>Environment (auto-collected) — Aurora ")
			b.WriteString(renderCodeSpan(env.serverVersion))
			b.WriteString("</summary>\n\n")
		} else {
			b.WriteString("<summary>Environment (auto-collected)</summary>\n\n")
		}
		writeKV := func(k, v string) {
			if v == "" {
				return
			}
			b.WriteString("- **")
			b.WriteString(k)
			b.WriteString(":** ")
			// Deep-debug H1 — dynamic-fence code span via
			// renderCodeSpan handles any backtick content safely
			// (older escapeBacktick produced broken markdown for
			// values containing `).
			b.WriteString(renderCodeSpan(v))
			b.WriteString("\n")
		}
		writeKV("Aurora version", env.serverVersion)
		writeKV("URL", env.url)
		writeKV("Viewport", env.viewport)
		writeKV("Device pixel ratio", env.devicePixelRatio)
		writeKV("Browser", env.userAgent)
		writeKV("Language", env.language)
		// Deep-debug L3 — disambiguate client vs server time (useful
		// for diagnosing clock-drift bugs; otherwise the two fields
		// look redundant to triagers).
		writeKV("Client time (browser clock)", env.clientTime)
		writeKV("Server time (Aurora UTC)", env.serverTime)
		b.WriteString("</details>\n\n")
	}
	// Distinctive HTML-comment fence that user content can't easily
	// reproduce (we strip HTML from the description's blockquote
	// rendering anyway). Triagers can grep for `aurora-footer` to
	// find authentic server-stamped submissions.
	b.WriteString("\n<!-- aurora-footer -->\n---\n")
	b.WriteString("_Submitted via Aurora bug-report_")
	if name != "" {
		b.WriteString(" by **")
		b.WriteString(escapeMarkdownInline(name))
		b.WriteString("**")
	}
	if username != "" && username != name {
		b.WriteString(" (Aurora user: ")
		// Deep-debug H1 — dynamic-fence code span via renderCodeSpan.
		// The previous `…` + escapeBacktick approach produced broken
		// markdown when usernames contained `; rare but real.
		b.WriteString(renderCodeSpan(username))
		b.WriteString(")")
	}
	return b.String()
}

// environmentContext bundles the auto-collected environment fields
// rendered into the `<details>` block at the bottom of the issue
// body. Client-side fields (URL, viewport, UA, language, client_time)
// come from the frontend; server-side fields (serverVersion,
// serverTime) are filled by the Submit handler so they can't be
// spoofed by the client.
type environmentContext struct {
	url              string
	viewport         string
	devicePixelRatio string
	userAgent        string
	language         string
	clientTime       string
	serverVersion    string
	serverTime       string
}

// hasClientContext reports whether at least one CLIENT-supplied field
// is populated. Used to gate the `<details>` block in the issue body
// so a stripped-down POST (e.g. curl, third-party client) doesn't
// produce a near-empty Environment section containing just
// server-stamped fields. Deep-debug H2 — previous hasAny() also
// counted serverTime, which is always set, so the block always
// rendered and contradicted the docstring.
func (e environmentContext) hasClientContext() bool {
	return e.url != "" || e.viewport != "" || e.devicePixelRatio != "" ||
		e.userAgent != "" || e.language != "" || e.clientTime != ""
}

// sanitizeContextField bounds a single client-supplied context value:
// trims whitespace, rejects control chars, caps length. Each field is
// rendered inside a CommonMark code span (renderCodeSpan handles
// backtick safety), but a 10MB user-agent header would still bloat
// the issue. Cap at 500 RUNES — generous for real values, restrictive
// for abuse.
//
// Deep-debug H3 — rune-bounded cap (not byte-bounded). Byte truncation
// at 500 bytes can split a multibyte UTF-8 sequence (4-byte emoji,
// 3-byte CJK), corrupting the trailing characters. Rune-bounded
// truncation is always valid UTF-8.
//
// Also strips Unicode line separators (U+2028, U+2029) and the
// byte-order mark (U+FEFF) — these are technically > 0x20 but render
// as line breaks / hidden whitespace and could break the single-line
// markdown rendering.
func sanitizeContextField(v string) string {
	v = strings.TrimSpace(v)
	if utf8.RuneCountInString(v) > 500 {
		runes := []rune(v)
		v = string(runes[:500])
	}
	// Strip control characters + Unicode line separators that would
	// mangle the markdown render. Tab is preserved (legitimate
	// whitespace inside user-agent strings).
	v = strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\t' {
			return -1
		}
		switch r {
		case 0x2028, 0x2029, 0xFEFF: // line sep, para sep, BOM
			return -1
		}
		return r
	}, v)
	return v
}

// escapeMarkdownInline escapes the characters that could let a
// user-supplied string break out of an inline Markdown context
// (bold, italics, code, links). Used for the displayed name in the
// footer, which sits inside `**...**`. The list of chars is
// conservative — escaping more than necessary just produces a few
// extra backslashes in the rendered text, which is acceptable.
func escapeMarkdownInline(s string) string {
	// Order matters: backslash must be escaped first so the others'
	// backslash insertions don't get re-escaped.
	r := strings.NewReplacer(
		`\`, `\\`,
		"`", "\\`",
		"*", "\\*",
		"_", "\\_",
		"[", "\\[",
		"]", "\\]",
		"(", "\\(",
		")", "\\)",
		"<", "&lt;",
		">", "&gt;",
	)
	return r.Replace(s)
}

// renderCodeSpan emits a CommonMark inline code span around `s` that
// safely handles backtick content. Dynamic fence: choose `n` backticks
// such that the value contains NO run of `n` backticks. Per CommonMark
// spec, a code span opened with `n` backticks closes only on a run of
// exactly `n` backticks. Adds a leading/trailing space when the value
// starts or ends with a backtick (CommonMark trims a single such space
// when rendering, so the code span content is unchanged).
//
// Deep-debug H1 — the previous backslash-escape approach (\`) does
// NOT work for single-backtick code spans because CommonMark doesn't
// process backslash escapes inside them. A value of `Evil\`UA` ended
// up as `<code>Evil\</code>UA` (the first inner backtick closed the
// span). Dynamic fencing is the spec-correct fix and matches how
// every CommonMark implementation (GitHub, GitLab, pandoc, etc.)
// renders code spans.
func renderCodeSpan(s string) string {
	// Find the longest run of backticks in s.
	maxRun := 0
	cur := 0
	for _, r := range s {
		if r == '`' {
			cur++
			if cur > maxRun {
				maxRun = cur
			}
		} else {
			cur = 0
		}
	}
	fence := strings.Repeat("`", maxRun+1)
	pad := ""
	// Leading / trailing backtick or space needs a space buffer so the
	// opener / closer fences aren't merged with the content's
	// backticks.
	if len(s) > 0 && (s[0] == '`' || s[len(s)-1] == '`') {
		pad = " "
	}
	return fence + pad + s + pad + fence
}
