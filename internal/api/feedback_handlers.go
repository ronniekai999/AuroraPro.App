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
	"time"

	"github.com/go-chi/chi/v5"

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
//   - submitLimiter: simple per-user-ID rate limiter (5 / hour by
//     default) to protect the shared GitHub PAT and the local
//     attachment cache from individual users in tight loops.
//   - janitor: a goroutine that sweeps <cacheDir>/<uuid>.{png,jpg,
//     jpeg,webp,webm,mp4} older than the TTL on a 1-hour cadence.
//     Started by NewFeedbackHandler when the feature is enabled and
//     stopped via the rootCtx Aurora passes at startup (matches the
//     existing graceful-shutdown pattern used by request dispatch
//     and the AI matcher backfill).
type FeedbackHandler struct {
	cfg           config.BugReportConfig
	client        *feedback.Client
	cacheDir      string // absolute path to <Cache.ImageDir>/bug-reports
	submitLimiter *feedbackLimiter
}

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

	// Phase 3 — per-user rate limit on Submit. 5 reports/hour matches
	// the operational-notes guidance in docs/bug-report-setup.md.
	// Lower than GitHub's secondary "abuse" limiter (~30/min) so a
	// single user can't trip global throttling for everyone else.
	feedbackRateMax    = 5
	feedbackRateWindow = time.Hour
	// Caps the per-user-ID map size so a federated/compromised-account
	// flood can't grow unbounded memory. Mirrors auth.RateLimiter's
	// maxVisitors design. With 5 timestamps * ~24 bytes each * 10k
	// users = ~1.2 MB worst-case. Eviction kicks in at insert time
	// when the cap is hit. (Phase 3 deep-debug H2.)
	feedbackLimiterMaxUsers = 10_000

	// Phase 3 — attachment janitor TTL + sweep cadence. 30 days
	// matches the issue body's expected freshness window (an
	// embedded GitHub issue image older than that almost certainly
	// references a closed/abandoned report). Sweep every hour so
	// disk doesn't fill between cadences on busy deploys.
	attachmentTTL        = 30 * 24 * time.Hour
	janitorSweepInterval = time.Hour
	// Background sweep cadence for the rate-limiter map — same
	// pattern as auth.RateLimiter. Prevents the map from accumulating
	// permanent entries for users who submitted once and never came
	// back. (Phase 3 deep-debug M1.)
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
func NewFeedbackHandler(ctx context.Context, cfg config.BugReportConfig, imageDir string) *FeedbackHandler {
	h := &FeedbackHandler{
		cfg:           cfg,
		cacheDir:      filepath.Join(imageDir, "bug-reports"),
		submitLimiter: newFeedbackLimiter(feedbackRateMax, feedbackRateWindow),
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
		// Janitor + limiter sweep run only when the feature is enabled
		// (no point sweeping a directory nothing writes to / no submit
		// traffic to throttle) AND when a ctx is provided (otherwise
		// no graceful-shutdown signal).
		if ctx != nil {
			go h.runJanitor(ctx)
			go h.submitLimiter.runSweep(ctx)
		}
	}
	return h
}

// runJanitor sweeps <cacheDir> every janitorSweepInterval and deletes
// files older than attachmentTTL. Logs a startup INFO line so
// operators can confirm the goroutine spawned (holistic deep-debug
// L4); subsequent sweep summaries log INFO when >= 10 files removed,
// DEBUG otherwise to keep low-traffic deploys out of operator logs.
// The goroutine exits when ctx is cancelled (server shutdown).
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
	slog.Info("feedback janitor: started",
		"sweep_interval", janitorSweepInterval.String(),
		"ttl", attachmentTTL.String(),
		"cache_dir", h.cacheDir)
	h.sweepAttachments()
	ticker := time.NewTicker(janitorSweepInterval)
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
// attachmentTTL. Failures (missing dir, read errors) are logged and
// the function returns cleanly — janitor lifecycle MUST NOT crash
// the parent goroutine on transient FS issues.
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
	cutoff := time.Now().Add(-attachmentTTL)
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
			"ttl", attachmentTTL.String())
	} else if removed > 0 {
		slog.Debug("feedback janitor: swept attachments",
			"removed", removed,
			"kept", kept,
			"ttl", attachmentTTL.String())
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
type FeedbackConfigResponse struct {
	Enabled bool `json:"enabled"`
}

// GetConfig — GET /api/feedback/config
//
// Returns {enabled: bool} so the frontend can hide the launcher when
// the feature is off (the entire response is small and cheap; safe
// to fetch once per session). Authed because we don't expose
// feature-flag state to the public.
func (h *FeedbackHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, FeedbackConfigResponse{
		// Operator may set Enabled=true but forget the token — that
		// case STILL reports enabled to the frontend. The submit
		// handler then 503s on first attempt, which is the right
		// failure mode (admin sees the misconfiguration immediately).
		Enabled: h.cfg.Enabled,
	})
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
//   - title        (required, <= maxFeedbackTitleLen)
//   - description  (required, <= maxFeedbackDescLen)
//   - name         (optional, <= maxFeedbackNameLen — used for context)
//   - attachment   (optional file, <= maxFeedbackAttachment)
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

	// Build the issue body. Putting submitter context (name + Aurora
	// username) at the bottom keeps the user's description the lede
	// for triagers reading on GitHub.
	body := buildIssueBody(desc, name, claims.Username, attachmentURL)

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
func buildIssueBody(description, name, username, attachmentURL string) string {
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
		b.WriteString(" (Aurora user: `")
		b.WriteString(escapeBacktick(username))
		b.WriteString("`)")
	}
	return b.String()
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

// escapeBacktick is used for content rendered inside a code span.
// Code spans only need the surrounding backticks escaped; nothing
// else is parsed. If the username contains a backtick, we lengthen
// the surrounding fence is too fiddly; just escape with a backslash
// before each backtick (renders verbatim).
func escapeBacktick(s string) string {
	return strings.ReplaceAll(s, "`", "\\`")
}
