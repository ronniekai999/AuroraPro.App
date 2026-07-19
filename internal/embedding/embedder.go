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
//   - 3: Phase E2b — BuildText now folds the content-rating audience/tone cue
//     into the text so gentle (TV-G) and intense (R) titles with near-identical
//     overviews separate in the vector space. Same 768 dims → no migration; the
//     bump alone makes RunBackfill re-embed in place.
//
// Phase E4 (qwen3-embedding swap) did NOT bump this: model changes are now
// detected by the llm_embed_model_active marker (see ensureModelSpace),
// which nulls-and-re-embeds whenever the effective model differs from the
// one that produced the stored vectors — including admin-UI model changes
// that a hardcoded migration/version bump could never see. This constant
// remains the TEXT-TEMPLATE version: bump it when BuildText's output
// changes, never for model swaps.
//
// Do NOT bump for trivial code refactors that produce identical output.
const CurrentVersion int16 = 3

// markerKey is the server_settings row recording which embedding model
// produced the vectors currently stored in media_items.embedding. Written
// by ensureModelSpace after it verifies (or restores) space consistency.
const markerKey = "llm_embed_model_active"

// Embedder coordinates the embedding model client with the database. Safe for
// concurrent use; multiple goroutines may call EmbedItem in parallel.
type Embedder struct {
	llm     *llm.Client
	q       *db.Queries
	workers int
	batch   int
	// modelPinned records whether the operator explicitly chose the embed
	// model (env LLM_EMBED_MODEL or a DB llm_embed_model row), as opposed to
	// following the binary default. ensureModelSpace uses it to decide how to
	// treat pre-marker installs: pinned vectors are adopted as-is (the pin
	// predates the marker, so the stored vectors were produced by it), while
	// default-following vectors must be nulled on a default swap.
	modelPinned bool
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

// SetModelPinned tells the embedder whether the effective embed model came
// from an explicit operator choice. Call before RunBackfill; main.go wires it
// from the env var / DB override presence.
func (e *Embedder) SetModelPinned(pinned bool) { e.modelPinned = pinned }

// markerAction is ensureModelSpace's decision for the current boot.
type markerAction int

const (
	markerKeep  markerAction = iota // marker matches — nothing to do
	markerAdopt                     // write marker, keep vectors (pre-marker pinned install, or empty library)
	markerReset                     // model changed — null all vectors, then write marker
)

// decideMarkerAction is the pure decision core of ensureModelSpace, split out
// for direct unit testing.
//
//   - marker == effective → keep.
//   - marker set but different → the stored vectors are from another model's
//     space → reset (null + re-embed). This covers admin-UI/env model changes.
//   - marker missing (pre-E4 install or fresh DB):
//     pinned    → adopt: the operator's explicit model predates the marker, so
//     the stored vectors were produced by it; nulling would be a
//     pointless same-space re-embed outage.
//     unpinned  → reset: the vectors followed the OLD binary default while the
//     effective model is the NEW default (the E4 swap) — spaces
//     differ, so they must be nulled. On a fresh library the UPDATE
//     touches zero rows, making this a cheap marker write.
func decideMarkerAction(marker string, markerExists bool, effective string, pinned bool) markerAction {
	if markerExists && marker == effective {
		return markerKeep
	}
	if markerExists {
		return markerReset
	}
	if pinned {
		return markerAdopt
	}
	return markerReset
}

// ensureModelSpace guarantees the stored vectors and the effective embedding
// model belong to the same vector space before any backfill work runs.
// Different models embed into unrelated spaces; a mixed column silently
// corrupts every cosine ranking, which is why model changes MUST null the
// old vectors. Centralizing the rule here (instead of per-swap migrations
// like 040's null step) also covers model changes made through the admin UI
// or env — paths a migration can never see.
//
// Best-effort: on read/write errors we log and skip (returning true) rather
// than block embedding entirely — the next boot retries.
func (e *Embedder) ensureModelSpace(ctx context.Context) {
	effective := e.llm.EmbedModel()
	marker, exists, err := e.q.GetSettingExists(ctx, markerKey)
	if err != nil {
		slog.Warn("embedding: model-marker read failed; skipping space check this boot", "error", err)
		return
	}
	switch decideMarkerAction(marker, exists, effective, e.modelPinned) {
	case markerKeep:
		return
	case markerAdopt:
		slog.Info("embedding: adopting existing vectors for pinned model", "model", effective)
	case markerReset:
		nulled, err := e.q.NullAllEmbeddings(ctx)
		if err != nil {
			slog.Error("embedding: model changed but nulling old vectors failed — NOT updating marker; retry next boot",
				"old_marker", marker, "model", effective, "error", err)
			return
		}
		if nulled > 0 {
			slog.Info("embedding: model changed — cleared old-space vectors for re-embed",
				"old_marker", marker, "model", effective, "cleared", nulled)
		}
	}
	if err := e.q.SetSetting(ctx, markerKey, effective); err != nil {
		slog.Warn("embedding: model-marker write failed; space check will re-run next boot", "error", err)
	}
}

// BuildText assembles the canonical text representation of a media item.
// Phase-3 HyDE pseudo-docs will be generated to match this exact shape so
// query and catalog vectors live in the same semantic space.
//
// Output examples:
//
//	"Inception (2010). [movie] A thief who steals corporate secrets... Genres: Action, Sci-Fi. For mature audiences."
//	"Severance (2022). [tv] Office workers undergo a procedure... Genres: Drama, Mystery, Sci-Fi. For mature audiences."
//
// Empty fields are skipped rather than rendered as "(0)" or "Genres: ." so the
// embedding model isn't confused by structural noise.
//
// Phase E2b: the content-rating audience cue (audienceClause) is appended as a
// tone axis. Genre tags + overview alone don't separate a gentle TV-PG ghost
// drama from an R ghost-horror film — their overviews are near-identical ("ghosts",
// "hauntings") — so they cluster together. The audience phrase ("For family and
// general audiences" vs "For mature audiences") gives the model a maturity/tone
// signal that pulls them apart.
func BuildText(title string, year int, mediaType, overview string, genres []string, contentRating string) string {
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
		// Cap overview at ~2000 chars. Originally forced by embeddinggemma's
		// 2048-token context (Ollama silently truncates beyond a model's
		// window, degrading embeddings without a signal). The Phase E4
		// default (qwen3-embedding, 32K context) no longer needs it, but the
		// cap stays: pathological NFO files from scraper plugins can carry
		// multi-MB synopses, the lead ~2000 chars carry the retrieval signal
		// anyway, and the cap keeps per-batch payloads small and narrower
		// fallback models safe.
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
	// Only fold in the audience/tone cue when there's real content to tone. For a
	// title-only item (pre-enrichment scan, obscure unmatched media) the fixed
	// phrase would DOMINATE the few tokens and cluster items by rating tier
	// instead of content — a regression vs the honest title-only vector.
	if overview != "" || len(genres) > 0 {
		b.WriteString(audienceClause(contentRating))
	}
	return strings.TrimSpace(b.String())
}

// audienceClause maps a content rating to a natural-language audience/tone cue
// for the embedding text, or "" when the rating is missing/unknown (NR, Unrated,
// blank) so no misleading signal is added. The phrasing is deliberately tonal —
// "mature" reads as darker/intense, "family" as lighter — which is the axis we
// want the vector to encode. Returned with a leading space so the caller can
// append unconditionally.
func audienceClause(rating string) string {
	switch strings.ToUpper(strings.TrimSpace(rating)) {
	case "G", "TV-Y", "TV-Y7", "TV-Y7-FV", "TV-G", "PG", "TV-PG":
		return " For family and general audiences."
	case "PG-13", "TV-14":
		return " For teen and older audiences."
	case "R", "TV-MA", "NC-17", "NC17", "X":
		return " For mature audiences."
	default:
		return ""
	}
}

// EmbedItem regenerates the embedding for a single media item. Called from the
// scanner's OnNewItem hook (after enrichment) so newly-imported content is
// searchable immediately. Genres must be populated by the caller.
//
// Errors are returned but the caller should log-and-continue: a missing
// embedding only degrades search, never breaks ingestion.
func (e *Embedder) EmbedItem(ctx context.Context, item *models.MediaItem) error {
	text := BuildText(item.Title, item.Year, string(item.Type), item.Overview, item.Genres, item.ContentRating)
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
	// FIRST: make sure the stored vectors and the effective model share a
	// vector space (nulls the column when the model changed). Must precede
	// the pending count — a model change turns "nothing to do" into
	// "re-embed everything".
	e.ensureModelSpace(ctx)

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
	// Per-row write failures are CONTAINED, not fatal: a row whose UPDATE
	// keeps failing (row-level constraint, lock timeout) lands in this set
	// and is filtered out of later waves, so it can neither hot-spin the
	// cursor-free fetch (it re-selects the lowest pending IDs forever) nor
	// abort the run and strand every higher-ID row. The cap bounds memory
	// and converts a SYSTEMIC write failure (everything failing) into a
	// clean give-up instead of a 1000-entry crawl.
	const maxFailedWrites = 1000
	failedWrites := make(map[int64]struct{})
	for {
		if ctx.Err() != nil {
			slog.Info("embedding backfill: cancelled", "embedded", done, "remaining", pending-done)
			return
		}
		// Widen the fetch window by the number of known-bad rows: they still
		// match the pending predicate, so they occupy the front of the
		// id-ordered window and would otherwise hide live rows behind them.
		candidates, err := e.q.FetchEmbeddingCandidates(ctx, CurrentVersion, waveSize+len(failedWrites))
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
		live := filterFailed(candidates, failedWrites)
		if len(live) == 0 {
			slog.Error("embedding backfill: every remaining pending row has a failing write; stopping",
				"failed_rows", len(failedWrites), "embedded", done)
			return
		}
		if len(live) > waveSize {
			live = live[:waveSize]
		}
		// Split the wave into batch-sized chunks and embed them concurrently.
		// Each chunk holds DISTINCT item IDs (the fetch returned a single
		// ordered window), so the parallel embedBatch calls never contend on
		// the same rows. We wait for the whole wave before fetching again so
		// the cursor-free fetch query advances past these rows.
		embedded, failedIDs, waveErr := e.runWave(ctx, live, workers, batch)
		done += embedded
		for _, id := range failedIDs {
			failedWrites[id] = struct{}{}
		}
		if len(failedIDs) > 0 {
			slog.Warn("embedding backfill: row writes failed; excluding rows for this run",
				"count", len(failedIDs), "total_excluded", len(failedWrites))
			if len(failedWrites) > maxFailedWrites {
				slog.Error("embedding backfill: write failures look systemic, giving up",
					"failed_rows", len(failedWrites), "embedded", done)
				return
			}
		}
		if waveErr != nil {
			// Embed-call (LLM-side) failure — the whole chunk got no vectors.
			// This is the transient-Ollama-outage path: back off, give up
			// after maxFailures. Write failures deliberately do NOT feed this
			// counter (they're contained above and the loop makes progress
			// past them).
			failures++
			if failures >= maxFailures {
				slog.Error("embedding backfill: too many embed failures, giving up",
					"failures", failures, "embedded", done, "last_error", waveErr,
					"hint", "if the error is model-not-found, run: ollama pull "+e.llm.EmbedModel())
				return
			}
			wait := backoffDelay()
			slog.Warn("embedding backfill: wave failed, backing off",
				"error", waveErr, "wave_size", len(live), "attempt", failures, "wait", wait)
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
	slog.Info("embedding backfill: complete", "embedded", done,
		"write_failures", len(failedWrites), "elapsed", time.Since(start).Round(time.Second))
}

// filterFailed returns the candidates whose IDs are not in the failed set,
// preserving order. Pure; unit-tested directly.
func filterFailed(cands []*db.EmbeddingCandidate, failed map[int64]struct{}) []*db.EmbeddingCandidate {
	if len(failed) == 0 {
		return cands
	}
	out := make([]*db.EmbeddingCandidate, 0, len(cands))
	for _, c := range cands {
		if _, bad := failed[c.ID]; !bad {
			out = append(out, c)
		}
	}
	return out
}

// runWave embeds a single wave of candidates by splitting it into batch-sized
// chunks and running up to e.workers embedBatch calls concurrently. It returns
// the per-row count of successful writes, the IDs whose individual writes
// failed (for the caller's containment set), and the first EMBED-side error
// any chunk reported (nil when every chunk got vectors back — write failures
// are reported via the ID list, not the error). All goroutines are joined
// before returning, so no work outlives this call.
//
// The chunks share no item IDs (the caller passed one ordered fetch window),
// so concurrent embedBatch calls never race on the same media_items row. The
// shared state is the atomic counter, the mutex-guarded failure list, and the
// once-guarded error.
//
// workers and batch are passed in (already clamped to >= 1 by the caller) so
// the chunk size and concurrency bound stay consistent with the wave size.
func (e *Embedder) runWave(ctx context.Context, candidates []*db.EmbeddingCandidate, workers, batch int) (int64, []int64, error) {
	var (
		embedded  atomic.Int64
		wg        sync.WaitGroup
		errOnce   sync.Once
		firstErr  error
		failedMu  sync.Mutex
		failedIDs []int64
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
			written, failed, err := e.embedBatch(ctx, chunk)
			embedded.Add(int64(written))
			if len(failed) > 0 {
				failedMu.Lock()
				failedIDs = append(failedIDs, failed...)
				failedMu.Unlock()
			}
			if err != nil {
				errOnce.Do(func() { firstErr = err })
			}
		}(chunk)
	}
	wg.Wait()
	return embedded.Load(), failedIDs, firstErr
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
//
// Returns (rows successfully written, IDs whose write failed, embed error).
// The error is non-nil only when the EMBED call itself failed (no vectors
// for the whole chunk) — that's the transient-outage signal RunBackfill
// backs off on. Per-row write failures are logged and returned as IDs so the
// caller can exclude them from later waves: leaving them silently pending
// used to hot-spin the cursor-free fetch, and failing the whole wave on one
// bad row would strand every higher-ID item behind it.
func (e *Embedder) embedBatch(ctx context.Context, candidates []*db.EmbeddingCandidate) (int, []int64, error) {
	texts := make([]string, len(candidates))
	for i, c := range candidates {
		texts[i] = BuildText(c.Title, c.Year, c.Type, c.Overview, c.Genres, c.ContentRating)
	}
	vectors, err := e.llm.EmbedBatch(ctx, texts)
	if err != nil {
		return 0, nil, err
	}
	written := 0
	var failed []int64
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
			failed = append(failed, c.ID)
		} else {
			written++
		}
		writeCancel()
	}
	return written, failed, nil
}
