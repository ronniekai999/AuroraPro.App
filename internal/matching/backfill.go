package matching

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/db"
)

// defaultBackfillRate is the steady-state items-per-second the backfill
// worker targets when no override is configured. 1/sec is the right
// default: an LLM call takes 3-15s in practice, so the ticker is
// effectively a floor — saturation is already gated by LLM throughput.
// Lower rates let operators throttle further if they're sharing Ollama
// with other workloads.
const defaultBackfillRate = 1.0

// pageSize bounds the per-iteration DB fetch. Small page so a long
// backfill picks up newly-flagged items between pages (no risk of
// "started with 10000 items, finished at 9000 because new ones landed
// after the initial COUNT"). 25 also matches the GetFlaggedWithoutAISuggestion
// default.
const pageSize = 25

// Fetch-failure backoff matches the embedding backfill's pattern
// (internal/embedding/embedder.go:148-160). Exponential up to a cap, then
// give up after maxFetchFailures — without the cap, a persistently-down
// DB would keep the worker spinning forever, swallowing the boot log and
// hiding the real problem (deep-debugger Bug 7.3).
const (
	baseFetchBackoff = 5 * time.Second
	maxFetchBackoff  = 5 * time.Minute
	maxFetchFailures = 8 // ~5+10+20+40+80+160+300+300s ≈ 15 min total wait
)

// ErrJobInProgress is returned by StartJob when a manual run is already
// active. Surfaced to the admin endpoint as HTTP 409 Conflict so the
// operator knows the previous run is still going rather than getting an
// inscrutable 500.
var ErrJobInProgress = errors.New("ai match backfill: a job is already in progress")

// JobStatus is the externally-visible snapshot of an active or last-run
// manual backfill. Updated under mutex so the admin /status endpoint
// always sees a coherent view (no half-written counters).
//
// JobID is "" for boot-time runs (no admin endpoint to query for them);
// only manual runs via StartJob get a stable id.
type JobStatus struct {
	JobID      string    `json:"job_id,omitempty"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at,omitempty"`
	Total      int       `json:"total"`
	Processed  int       `json:"processed"`
	Matched    int       `json:"matched"`   // count auto-promoted to match_status='matched'
	Suggested  int       `json:"suggested"` // count where LLM returned a sub-threshold suggestion
	Failed     int       `json:"failed"`    // count where the matcher errored

	// Retry-pass stats (added 2026-05-26 after the Sneetches bug). The
	// retry pass scans rows where ai_match_confidence >= threshold but
	// match_status is still 'needs_review' — the auto-promote was
	// attempted at evaluation time and EnrichByTMDBID failed (transient
	// TMDB error). Retried = items the pass touched; RetryMatched =
	// items that successfully promoted on the retry. The difference is
	// items where TMDB STILL failed (likely a permanent issue with that
	// id — operator can investigate or manually match).
	Retried      int `json:"retried,omitempty"`
	RetryMatched int `json:"retry_matched,omitempty"`

	Cancelled bool `json:"cancelled,omitempty"`
}

// Backfiller owns the rate-limited background sweep over flagged items
// that haven't been AI-evaluated yet. Two entry points:
//
//   - Run(ctx): one-shot at boot, no JobStatus tracking, returns when the
//     queue is empty or ctx cancels.
//   - StartJob(ctx): manual admin trigger, returns a job id immediately
//     and runs in its own goroutine; JobStatus() reports progress.
//
// Only one job (boot OR manual) can run at a time; StartJob returns
// ErrJobInProgress if you try to overlap them. The mutex guards both
// `job` and `cancel`, so reading JobStatus is always coherent.
type Backfiller struct {
	matcher *AIMatcher
	queries *db.Queries
	rate    float64 // items per second

	mu     sync.Mutex
	job    *JobStatus         // nil when no job has ever run
	cancel context.CancelFunc // non-nil while a manual job is active
}

// NewBackfiller wires the dependencies. ratePerSec <= 0 means "use the
// default" (1/sec) — matches the env-var fallback in main.go.
func NewBackfiller(matcher *AIMatcher, queries *db.Queries, ratePerSec float64) *Backfiller {
	if ratePerSec <= 0 {
		ratePerSec = defaultBackfillRate
	}
	return &Backfiller{matcher: matcher, queries: queries, rate: ratePerSec}
}

// Run is the boot-time entry point: count pending items, log "starting" if
// any exist, then drive the loop until empty or ctx cancels. Idempotent —
// calling Run a second time when there's nothing to do is a cheap COUNT
// query and returns immediately.
//
// Reserves the job slot via the same mutex as StartJob so a concurrent
// admin "Re-match" click during a long boot run doesn't spawn a second
// goroutine paging the same queue and doubling the LLM call rate
// (deep-debugger Bug 3.1). Boot runs use a synthetic "boot-<ts>" JobID
// so the admin /status endpoint can show "boot run in progress" rather
// than appearing to never have run.
//
// Safe to call as `go bf.Run(ctx)` from main.go. Cooperatively shuts down
// when ctx is cancelled by the existing SIGTERM handler.
func (b *Backfiller) Run(ctx context.Context) {
	pending, err := b.queries.CountFlaggedWithoutAISuggestion(ctx)
	if err != nil {
		slog.Warn("ai match backfill: count failed, skipping boot run", "error", err)
		return
	}
	if pending == 0 {
		slog.Info("ai match backfill: nothing to do at boot")
		return
	}

	b.mu.Lock()
	if b.job != nil && b.job.FinishedAt.IsZero() {
		b.mu.Unlock()
		slog.Info("ai match backfill: boot run skipped, another job in progress",
			"existing_job", b.job.JobID)
		return
	}
	jobID := "boot-" + time.Now().Format("150405")
	b.job = &JobStatus{
		JobID:     jobID,
		StartedAt: time.Now(),
		Total:     pending,
	}
	b.mu.Unlock()

	slog.Info("ai match backfill: starting boot run",
		"job_id", jobID, "pending", pending,
		"rate_per_sec", b.rate, "auto_threshold", b.matcher.AutoThreshold())
	b.runLoop(ctx, pending, jobID)
}

// StartJob kicks off a one-shot manual sweep and returns a job id the
// admin UI can poll against /status. Detaches from the request context
// (HTTP request times out in 60s, the job often takes minutes) but
// inherits cancellation if the parent's RootCtx fires — see the
// `context.WithoutCancel` + WithCancel combo below.
//
// Returns ErrJobInProgress if a job is already active (boot run OR
// previous manual run that's still going). Operator sees 409 and knows
// to wait rather than getting a confusing duplicate run.
func (b *Backfiller) StartJob(parentCtx context.Context) (string, error) {
	b.mu.Lock()
	if b.job != nil && b.job.FinishedAt.IsZero() {
		b.mu.Unlock()
		return "", ErrJobInProgress
	}

	pending, err := b.queries.CountFlaggedWithoutAISuggestion(parentCtx)
	if err != nil {
		b.mu.Unlock()
		return "", err
	}

	jobID := newJobID()
	// Detach from the HTTP request ctx (which cancels in 60s) but keep
	// cancellation from the server-lifecycle ctx via the parent we got
	// passed. context.WithoutCancel strips the request deadline; the
	// outer WithCancel gives us a handle for explicit job cancellation
	// (not currently exposed but trivial to add).
	ctx, cancel := context.WithCancel(context.WithoutCancel(parentCtx))
	b.cancel = cancel
	b.job = &JobStatus{
		JobID:     jobID,
		StartedAt: time.Now(),
		Total:     pending,
	}
	b.mu.Unlock()

	go b.runLoop(ctx, pending, jobID)
	return jobID, nil
}

// JobStatus returns a copy of the most recent job's status, or nil if no
// job has ever run. Copy semantics ensure the admin endpoint can't see a
// half-updated struct mid-iteration.
func (b *Backfiller) JobStatus() *JobStatus {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.job == nil {
		return nil
	}
	copy := *b.job
	return &copy
}

// runLoop is the actual paging + rate-limited LLM-call loop. Shared
// between boot Run() (jobID="boot-<ts>") and manual StartJob() (jobID
// random hex). Both paths track stats — the deep-debugger pass flagged
// that the old "empty jobID = no tracking" was a subtle bug since boot
// runs are by far the longest in practice.
func (b *Backfiller) runLoop(ctx context.Context, total int, jobID string) {
	defer func() {
		b.mu.Lock()
		if b.job != nil && b.job.JobID == jobID {
			if b.job.FinishedAt.IsZero() {
				b.job.FinishedAt = time.Now()
			}
			if ctx.Err() != nil {
				b.job.Cancelled = true
			}
		}
		// Clear cancel only if it belongs to this job. Defensive — the
		// mutex-held window in StartJob makes it impossible for another
		// job's cancel to leak in here, but a future refactor could
		// break the invariant.
		b.cancel = nil
		b.mu.Unlock()
	}()

	// time.Ticker as a rate floor — actual call rate is min(ticker, LLM throughput).
	// In practice the LLM call dominates so the ticker is rarely the
	// bottleneck; the value of the ticker is that on very-fast LLMs
	// (small local quantized models on a beefy GPU) it prevents us from
	// hammering Ollama at hundreds of req/sec.
	interval := time.Duration(float64(time.Second) / b.rate)
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	start := time.Now()
	var processed, fetchFailures int
	for {
		if ctx.Err() != nil {
			slog.Info("ai match backfill: cancelled",
				"job_id", jobID, "processed", processed,
				"elapsed", time.Since(start).Round(time.Second))
			return
		}
		items, err := b.queries.GetFlaggedWithoutAISuggestion(ctx, pageSize)
		if err != nil {
			fetchFailures++
			if fetchFailures >= maxFetchFailures {
				slog.Error("ai match backfill: too many fetch failures, giving up",
					"job_id", jobID, "failures", fetchFailures,
					"processed", processed, "last_error", err)
				return
			}
			wait := baseFetchBackoff << (fetchFailures - 1)
			if wait > maxFetchBackoff || wait <= 0 {
				wait = maxFetchBackoff
			}
			slog.Warn("ai match backfill: fetch failed, backing off",
				"job_id", jobID, "attempt", fetchFailures,
				"error", err, "wait", wait)
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
				continue
			}
		}
		// Successful fetch — reset the failure counter so transient
		// blips don't accumulate toward the give-up threshold.
		fetchFailures = 0

		if len(items) == 0 {
			slog.Info("ai match backfill: eval pass complete",
				"job_id", jobID, "processed", processed,
				"elapsed", time.Since(start).Round(time.Second))
			// Eval pass done — run the retry pass for stuck high-
			// confidence items, then return.
			b.runRetryPass(ctx, jobID, ticker, start)
			return
		}
		for _, it := range items {
			select {
			case <-ctx.Done():
				slog.Info("ai match backfill: cancelled mid-page",
					"job_id", jobID, "processed", processed)
				return
			case <-ticker.C:
			}
			sug, err := b.matcher.Match(ctx, it)
			b.updateStats(jobID, sug, err)
			processed++
			if processed%50 == 0 || processed == total {
				slog.Info("ai match backfill: progress",
					"job_id", jobID, "processed", processed, "of", total,
					"elapsed", time.Since(start).Round(time.Second))
			}
		}
	}
}

// runRetryPass walks rows where the AI matcher previously produced an
// auto-eligible suggestion but the EnrichByTMDBID call failed at
// evaluation time, leaving the row stuck in 'needs_review'. Re-attempts
// EnrichByTMDBID with no new LLM call — the AI's pick is already
// cached on the row. Each pass is naturally bounded (no fan-out, just
// pages through the predicate until empty), so a permanently-bad TMDB
// id can't loop us forever: we try once, log the failure, move on,
// and the operator sees the row in the Flagged tab to manually handle.
//
// The pass uses the SAME ticker as the eval pass so the rate-limit
// applies to combined matcher activity. Cooperatively cancels on
// ctx.Done() just like the main loop.
func (b *Backfiller) runRetryPass(ctx context.Context, jobID string, ticker *time.Ticker, start time.Time) {
	threshold := b.matcher.AutoThreshold()
	var fetchFailures int

	// 2026-05-27 (deep-debug Bug 5 fix) — per-session attempted-id set.
	// Without this, a row whose EnrichByTMDBID permanently fails (bad
	// TMDB id, TMDB outage longer than this run) stays in the query's
	// predicate forever — successful promotes flip the row to
	// match_status='matched' and drop out, failed promotes don't update
	// any field, so the same page keeps coming back. The "naturally
	// bounded" claim in the original header comment was wrong.
	//
	// In-memory set is fine for the bounded scope of one backfill run:
	// (a) eval pass is bounded by len(needs-eval rows), (b) retry pass
	// is now bounded by len(retry-eligible rows) — each retried row is
	// either promoted (gone from predicate) or in `attempted` (skipped).
	// Memory: int64 = 8 bytes, 10k retries = 80 KB. Negligible.
	attempted := make(map[int64]struct{})

	for {
		if ctx.Err() != nil {
			slog.Info("ai match retry pass: cancelled",
				"job_id", jobID, "elapsed", time.Since(start).Round(time.Second))
			return
		}
		items, err := b.queries.GetFlaggedPendingAutoPromote(ctx, threshold, pageSize)
		if err != nil {
			fetchFailures++
			if fetchFailures >= maxFetchFailures {
				slog.Error("ai match retry pass: too many fetch failures, giving up",
					"job_id", jobID, "failures", fetchFailures, "last_error", err)
				return
			}
			wait := baseFetchBackoff << (fetchFailures - 1)
			if wait > maxFetchBackoff || wait <= 0 {
				wait = maxFetchBackoff
			}
			slog.Warn("ai match retry pass: fetch failed, backing off",
				"job_id", jobID, "attempt", fetchFailures, "error", err, "wait", wait)
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
				continue
			}
		}
		fetchFailures = 0

		// Filter out items we've already tried this session. If the
		// remaining set is empty AND the raw page was non-empty, we've
		// exhausted retry-eligible work — every remaining row is one
		// we couldn't promote and we'd just keep cycling through them.
		fresh := items[:0]
		for _, it := range items {
			if _, seen := attempted[it.ID]; !seen {
				fresh = append(fresh, it)
			}
		}
		if len(fresh) == 0 {
			slog.Info("ai match backfill: retry pass complete",
				"job_id", jobID,
				"persistent_failures", len(attempted),
				"elapsed", time.Since(start).Round(time.Second))
			return
		}
		for _, it := range fresh {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			attempted[it.ID] = struct{}{} // record BEFORE the call so failures don't slip past
			promoted, err := b.matcher.RetryAutoPromote(ctx, it)
			b.updateRetryStats(jobID, promoted, err)
			if err != nil {
				slog.Warn("ai match retry pass: enrich still failing",
					"job_id", jobID, "item_id", it.ID, "title", it.Title, "error", err)
			}
		}
	}
}

// updateStats bumps the JobStatus counters for the active job. The
// matcher guarantees that on success either sug.Promoted=true (counted
// as Matched), sug has a sub-threshold suggestion with TMDBID > 0
// (Suggested), or sug is nil/empty (no candidates — neither Matched nor
// Suggested, just Processed). Boot runs and manual runs both call here;
// the jobID-match guard prevents an old runLoop's stats from leaking
// into a newer job that started in the same process (shouldn't happen
// given the StartJob mutex check but defense-in-depth).
func (b *Backfiller) updateStats(jobID string, sug *Suggestion, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.job == nil || b.job.JobID != jobID {
		return // job rotated out from under us; the new one tracks itself
	}
	b.job.Processed++
	if err != nil {
		b.job.Failed++
		return
	}
	if sug == nil {
		return // no candidates / LLM returned no useful pick
	}
	if sug.Promoted {
		b.job.Matched++
		return
	}
	if sug.TMDBID > 0 {
		b.job.Suggested++
	}
}

// updateRetryStats bumps the retry-pass counters. Same jobID guard as
// updateStats. Failed retries are tracked implicitly as (Retried -
// RetryMatched) so the admin UI can show "tried N, X succeeded" without
// needing a separate counter. We INTENTIONALLY don't bump Failed here —
// the retry pass operating on rows the eval pass already counted
// (failed at eval-time too would have been bumped then). Keeping them
// separate avoids double-counting in dashboards.
func (b *Backfiller) updateRetryStats(jobID string, promoted bool, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.job == nil || b.job.JobID != jobID {
		return
	}
	b.job.Retried++
	if promoted && err == nil {
		b.job.RetryMatched++
	}
}

// newJobID returns a short hex correlation id. 8 chars = 4 random bytes,
// enough to disambiguate the handful of jobs an operator will run in a
// session. Same shape as the LLM client's reqID.
func newJobID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Vanishingly unlikely (crypto/rand should never fail on a
		// modern OS) but if it does, fall back to a timestamp-based id
		// so the admin endpoint still gets *something* unique.
		return "job-" + time.Now().Format("150405.000")
	}
	return hex.EncodeToString(b[:])
}
