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
	"sync"
	"sync/atomic"
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
//   - swap the embedding model, or change BuildText format → bump.
//
// Version history:
//   - 1: nomic-embed-text, 384-dim (truncated).
//   - 2: Phase E2 — embeddinggemma, 768-dim (migration 040 re-types the column +
//     nulls existing vectors; the bump makes RunBackfill re-embed everything).
//
// Do NOT bump for trivial code refactors that produce identical output.
const CurrentVersion int16 = 2

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
// outdated version) and embeds it. Designed to run as a background goroutine
// from main.go — it returns when there's nothing left to do, and respects ctx
// cancellation between waves.
//
// Concurrency (MED med-integration #2): work is processed in WAVES. Each wave
// fetches up to workers*batch candidates in one query (ordered by id ASC) and
// then runs up to `workers` embedBatch calls in parallel — one Ollama/Cloud
// HTTP round-trip per goroutine — so the expensive embedding step actually
// scales with the configured worker count. We deliberately keep a SINGLE
// serial fetcher: FetchEmbeddingCandidates has no claim/cursor (it re-selects
// rows WHERE embedding IS NULL OR version < current, LIMIT N), so it only
// advances because the previous rows are no longer pending once written. We
// must therefore wait for an entire wave's writes to commit before fetching
// the next wave; otherwise concurrent fetches would re-select the same lowest
// IDs and re-embed them N times (wasted Ollama/Cloud calls). With workers==1
// this reduces to the original one-batch-per-iteration loop.
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

	// Defensive clamp: New() already forces workers/batch to sane positives,
	// but RunBackfill must not deadlock or busy-loop if an Embedder is ever
	// built via a struct literal that bypasses New(). A zero waveSize would
	// make runWave construct a zero-capacity semaphore (deadlock), so pin both
	// to a minimum of 1 here.
	workers := e.workers
	if workers < 1 {
		workers = 1
	}
	batch := e.batch
	if batch < 1 {
		batch = 1
	}
	// One wave fetches at most this many candidates, then fans them out across
	// up to `workers` concurrent embedBatch calls (one HTTP round-trip each).
	waveSize := workers * batch
	for {
		if ctx.Err() != nil {
			slog.Info("embedding backfill: cancelled", "embedded", done, "remaining", pending-done)
			return
		}
		candidates, err := e.q.FetchEmbeddingCandidates(ctx, CurrentVersion, waveSize)
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
		// Split the wave into batch-sized chunks and embed them concurrently.
		// Each chunk holds DISTINCT item IDs (the fetch returned a single
		// ordered window), so the parallel embedBatch calls never contend on
		// the same rows. We wait for the whole wave before fetching again so
		// the cursor-free fetch query advances past these rows.
		embedded, waveErr := e.runWave(ctx, candidates, workers, batch)
		done += embedded
		if waveErr != nil {
			failures++
			if failures >= maxFailures {
				slog.Error("embedding backfill: too many batch failures, giving up",
					"failures", failures, "embedded", done, "last_error", waveErr)
				return
			}
			wait := backoffDelay()
			slog.Warn("embedding backfill: wave failed, backing off",
				"error", waveErr, "wave_size", len(candidates), "attempt", failures, "wait", wait)
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			continue
		}
		// Successful wave — reset the failure counter so transient blips
		// don't accumulate toward the give-up threshold.
		failures = 0
		// Use the clamped `batch` (not e.batch) so this modulus can never
		// divide by zero on the defensive bypass-New() path.
		if done%(int64(batch)*10) == 0 || done >= pending {
			slog.Info("embedding backfill: progress",
				"embedded", done, "of", pending, "elapsed", time.Since(start).Round(time.Second))
		}
	}
	slog.Info("embedding backfill: complete", "embedded", done, "elapsed", time.Since(start).Round(time.Second))
}

// runWave embeds a single wave of candidates by splitting it into batch-sized
// chunks and running up to e.workers embedBatch calls concurrently. It returns
// the number of items embedded across the chunks that SUCCEEDED (so the caller
// can keep an accurate running total even when one chunk fails) and the first
// error any chunk reported (nil if all chunks succeeded). All goroutines are
// joined before returning, so no work outlives this call.
//
// The chunks share no item IDs (the caller passed one ordered fetch window),
// so concurrent embedBatch calls never race on the same media_items row. The
// only shared state here is the atomic counter and the once-guarded error.
//
// workers and batch are passed in (already clamped to >= 1 by the caller) so
// the chunk size and concurrency bound stay consistent with the wave size.
func (e *Embedder) runWave(ctx context.Context, candidates []*db.EmbeddingCandidate, workers, batch int) (int64, error) {
	var (
		embedded atomic.Int64
		wg       sync.WaitGroup
		errOnce  sync.Once
		firstErr error
	)
	// Bound concurrency to `workers` even if the wave holds more chunks than
	// that (it won't under normal sizing, but stay robust to odd batch/worker
	// ratios). The caller guarantees workers >= 1.
	sem := make(chan struct{}, workers)
	for _, r := range chunkRanges(len(candidates), batch) {
		chunk := candidates[r[0]:r[1]]

		wg.Add(1)
		sem <- struct{}{}
		go func(chunk []*db.EmbeddingCandidate) {
			defer wg.Done()
			defer func() { <-sem }()
			if err := e.embedBatch(ctx, chunk); err != nil {
				errOnce.Do(func() { firstErr = err })
				return
			}
			embedded.Add(int64(len(chunk)))
		}(chunk)
	}
	wg.Wait()
	return embedded.Load(), firstErr
}

// chunkRanges partitions [0,n) into consecutive [start,end) half-open ranges of
// at most `batch` items each. The ranges are gap-free and non-overlapping, so
// concatenating the slices they describe reconstructs the original exactly —
// the property runWave relies on to embed every candidate once and only once.
// A non-positive batch is treated as 1 to avoid a zero-step infinite loop.
func chunkRanges(n, batch int) [][2]int {
	if batch < 1 {
		batch = 1
	}
	if n <= 0 {
		return nil
	}
	ranges := make([][2]int, 0, (n+batch-1)/batch)
	for start := 0; start < n; start += batch {
		end := start + batch
		if end > n {
			end = n
		}
		ranges = append(ranges, [2]int{start, end})
	}
	return ranges
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
