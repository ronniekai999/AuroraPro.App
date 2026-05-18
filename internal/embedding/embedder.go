// Package embedding owns the lifecycle of media-item embeddings: the text
// template, the backfill worker, and the per-item refresh hook used by the
// scanner / enricher when content changes.
//
// It deliberately depends on internal/llm (for the Ollama client) and
// internal/db (for the queries) but exposes a small surface to main.go:
//
//	emb := embedding.New(llmClient, queries)
//	go emb.RunBackfill(ctx)         // one-shot at startup
//	emb.EmbedItem(ctx, item)        // called from scanner.OnNewItem
package embedding

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/models"
)

// CurrentVersion is bumped whenever the embedding model or text template
// changes in a way that invalidates stored vectors. The backfill worker
// re-embeds any rows whose stored version is < CurrentVersion.
//
// Bump rules:
//   - 1 → 2: swapped embedding model (e.g. nomic → bge)
//   - 1 → 2: changed BuildText format
// Do NOT bump for trivial code refactors that produce identical output.
const CurrentVersion int16 = 1

// Embedder coordinates the embedding model client with the database. Safe for
// concurrent use; multiple goroutines may call EmbedItem in parallel.
type Embedder struct {
	llm     *llm.Client
	q       *db.Queries
	workers int
	batch   int
}

// New constructs an Embedder. workers controls backfill concurrency; batch is
// the number of items embedded per Ollama call (Ollama batches in-process,
// reducing per-call overhead).
func New(llmClient *llm.Client, q *db.Queries, workers, batch int) *Embedder {
	if workers <= 0 {
		workers = 2
	}
	if batch <= 0 {
		batch = 16
	}
	return &Embedder{llm: llmClient, q: q, workers: workers, batch: batch}
}

// BuildText assembles the canonical text representation of a media item.
// Phase-3 HyDE pseudo-docs will be generated to match this exact shape so
// query and catalog vectors live in the same semantic space.
//
// Output examples:
//
//	"Inception (2010). [movie] A thief who steals corporate secrets... Genres: Action, Sci-Fi."
//	"Severance (2022). [tv] Office workers undergo a procedure... Genres: Drama, Mystery, Sci-Fi."
//
// Empty fields are skipped rather than rendered as "(0)" or "Genres: ." so the
// embedding model isn't confused by structural noise.
func BuildText(title string, year int, mediaType, overview string, genres []string) string {
	var b strings.Builder
	b.WriteString(title)
	if year > 0 {
		fmt.Fprintf(&b, " (%d)", year)
	}
	b.WriteString(". ")
	if mediaType != "" {
		fmt.Fprintf(&b, "[%s] ", mediaType)
	}
	if overview != "" {
		// Cap overview at ~2000 chars. nomic-embed-text accepts up to 8192
		// tokens (~32 KB of typical English) and Ollama silently truncates
		// beyond that, which produces degraded embeddings without a signal.
		// Pathological NFO files from scraper plugins can carry multi-MB
		// synopses; trimming up-front keeps the embedding quality
		// predictable and the per-batch payload small.
		const maxOverviewChars = 2000
		if len(overview) > maxOverviewChars {
			overview = overview[:maxOverviewChars]
		}
		b.WriteString(overview)
		if !strings.HasSuffix(overview, ".") {
			b.WriteByte('.')
		}
		b.WriteByte(' ')
	}
	if len(genres) > 0 {
		b.WriteString("Genres: ")
		b.WriteString(strings.Join(genres, ", "))
		b.WriteByte('.')
	}
	return strings.TrimSpace(b.String())
}

// EmbedItem regenerates the embedding for a single media item. Called from the
// scanner's OnNewItem hook (after enrichment) so newly-imported content is
// searchable immediately. Genres must be populated by the caller.
//
// Errors are returned but the caller should log-and-continue: a missing
// embedding only degrades search, never breaks ingestion.
func (e *Embedder) EmbedItem(ctx context.Context, item *models.MediaItem) error {
	text := BuildText(item.Title, item.Year, string(item.Type), item.Overview, item.Genres)
	vec, err := e.llm.Embed(ctx, text)
	if err != nil {
		return fmt.Errorf("embed item %d: %w", item.ID, err)
	}
	if vec == nil {
		return nil // empty input — leave embedding NULL
	}
	return e.q.SetItemEmbedding(ctx, item.ID, llm.FormatVector(vec), CurrentVersion)
}

// RunBackfill walks every media item that lacks an embedding (or has an
// outdated version) and embeds it in batches. Designed to run as a background
// goroutine from main.go — it returns when there's nothing left to do, and
// respects ctx cancellation between batches.
//
// Safe to invoke on every startup: if everything is up-to-date it returns
// immediately after a single COUNT query.
func (e *Embedder) RunBackfill(ctx context.Context) {
	pending, err := e.q.CountPendingEmbeddings(ctx, CurrentVersion)
	if err != nil {
		slog.Warn("embedding backfill: count failed, skipping", "error", err)
		return
	}
	if pending == 0 {
		slog.Info("embedding backfill: nothing to do", "version", CurrentVersion)
		return
	}
	slog.Info("embedding backfill: starting", "pending", pending, "version", CurrentVersion,
		"workers", e.workers, "batch", e.batch)

	start := time.Now()
	var done int64
	// Exponential backoff state. On every consecutive failure we double the
	// wait up to 5 min, then give up after maxFailures. A persistently-down
	// Ollama used to spin this loop forever logging every 5–30s; now it
	// quietly exits and the next process restart retries from scratch.
	const (
		baseBackoff = 5 * time.Second
		maxBackoff  = 5 * time.Minute
		maxFailures = 8 // ~5+10+20+40+80+160+300+300 ≈ 15 min total wait
	)
	failures := 0
	backoffDelay := func() time.Duration {
		d := baseBackoff << failures
		if d > maxBackoff || d <= 0 {
			d = maxBackoff
		}
		return d
	}

	for {
		if ctx.Err() != nil {
			slog.Info("embedding backfill: cancelled", "embedded", done, "remaining", pending-done)
			return
		}
		candidates, err := e.q.FetchEmbeddingCandidates(ctx, CurrentVersion, e.batch)
		if err != nil {
			failures++
			if failures >= maxFailures {
				slog.Error("embedding backfill: too many fetch failures, giving up",
					"failures", failures, "embedded", done, "remaining", pending-done, "last_error", err)
				return
			}
			wait := backoffDelay()
			slog.Warn("embedding backfill: fetch failed, backing off",
				"error", err, "attempt", failures, "wait", wait)
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
				continue
			}
		}
		if len(candidates) == 0 {
			break
		}
		if err := e.embedBatch(ctx, candidates); err != nil {
			failures++
			if failures >= maxFailures {
				slog.Error("embedding backfill: too many batch failures, giving up",
					"failures", failures, "embedded", done, "last_error", err)
				return
			}
			wait := backoffDelay()
			slog.Warn("embedding backfill: batch failed, backing off",
				"error", err, "size", len(candidates), "attempt", failures, "wait", wait)
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			continue
		}
		// Successful batch — reset the failure counter so transient blips
		// don't accumulate toward the give-up threshold.
		failures = 0
		done += int64(len(candidates))
		if done%(int64(e.batch)*10) == 0 || done >= pending {
			slog.Info("embedding backfill: progress",
				"embedded", done, "of", pending, "elapsed", time.Since(start).Round(time.Second))
		}
	}
	slog.Info("embedding backfill: complete", "embedded", done, "elapsed", time.Since(start).Round(time.Second))
}

// embedBatch sends one Ollama call for the whole batch, then writes results
// back row-by-row. We intentionally do not use a transaction — partial
// progress is fine and recoverable on the next run.
func (e *Embedder) embedBatch(ctx context.Context, candidates []*db.EmbeddingCandidate) error {
	texts := make([]string, len(candidates))
	for i, c := range candidates {
		texts[i] = BuildText(c.Title, c.Year, c.Type, c.Overview, c.Genres)
	}
	vectors, err := e.llm.EmbedBatch(ctx, texts)
	if err != nil {
		return err
	}
	for i, c := range candidates {
		if vectors[i] == nil {
			continue // empty text — skip rather than store a zero vector
		}
		// Conditional write so an inline EmbedItem call (from scanner /
		// enricher) that landed mid-batch isn't overwritten with our
		// older snapshot of the text.
		//
		// Detach from the worker ctx with a short hard deadline: the
		// embed call has already succeeded (and on Cloud it incurred API
		// cost), so a shutdown signal arriving NOW shouldn't drop the
		// vectors we already paid for. 5s is generous for a tiny UPDATE.
		writeCtx, writeCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		if err := e.q.SetItemEmbeddingIfStale(writeCtx, c.ID, llm.FormatVector(vectors[i]), CurrentVersion); err != nil {
			slog.Warn("embedding backfill: write failed", "id", c.ID, "error", err)
		}
		writeCancel()
	}
	return nil
}
