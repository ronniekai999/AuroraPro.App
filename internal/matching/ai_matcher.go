// Package matching owns the AI-driven re-matching pipeline for media items
// that the heuristic enricher flagged as 'needs_review' (TMDB confidence
// 50..84). It deliberately depends on internal/llm (chat client),
// internal/metadata (TMDB search + EnrichByTMDBID), internal/models, and
// internal/db (UpdateAISuggestion + paging queries) and exposes a small
// surface to main.go:
//
//	m := matching.NewAIMatcher(llmClient, tmdb, enricher, queries, 90)
//	bf := matching.NewBackfiller(m, queries, 1.0)
//	go bf.Run(ctx)              // one-shot at startup for any existing flagged items
//	m.Match(ctx, item)          // called from scanner.OnNewItem when enricher landed at 50..84
//
// The matcher fetches a small TMDB candidate set for each item, asks the
// configured chat model to pick the best one (reusing the same model as
// search rerank — single mental model, single tuning knob), and either
// auto-promotes to 'matched' via the existing enricher.EnrichByTMDBID path
// (when LLM confidence >= AutoThreshold) or persists the suggestion for
// one-click operator approval (when below).
//
// Lifecycle parallels internal/embedding: per-item inline call from the
// scanner hooks + a background backfill goroutine for pre-existing rows.
package matching

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/metadata"
	"github.com/aurora-media/aurora/internal/models"
)

// matchStatusMatched is the literal status string the heuristic enricher
// writes for confirmed matches. Duplicated here (rather than imported from
// a shared constant) because the matching package shouldn't depend on
// metadata for a single string literal — keep the coupling minimal.
const matchStatusMatched = "matched"

// aiMatchBudget caps the per-item LLM round-trip. 30s is between the
// rerankBudget (45s, search/rerank.go:35) and the typical query-parse
// budget (also 30s) — the prompt size is comparable (~3KB with 10
// candidates) so the response budget matches.
//
// On timeout the matcher returns an error, the item is marked evaluated
// with no suggestion (so the backfill doesn't loop on it), and the next
// item proceeds. Same fail-forward stance as the embedder.
const aiMatchBudget = 30 * time.Second

// aiMatchCandidateMax caps how many TMDB candidates we ask the LLM to
// pick between. 10 is enough to differentiate plausible matches (TMDB
// already ranks by popularity, so the top 10 contain the right answer in
// every test case we've run) without ballooning the prompt — at 240
// chars/overview that's ~3KB, well inside any model's context window.
//
// Going higher (15+) starts to hurt: gpt-oss thinking-trace size scales
// with prompt size, and at 25 candidates the response started timing out
// our 30s budget on local Ollama.
const aiMatchCandidateMax = 10

// Suggestion is the matcher's verdict for one item. Promoted is true iff
// the matcher auto-promoted the item via EnrichByTMDBID — the suggestion
// fields are still meaningful in that case (they're the audit trail of
// what the AI picked), but the item has already left the flagged list.
//
// Confidence/Reasoning may be populated with TMDBID=0 when the LLM
// answered "no candidate fits" — surfaced to the operator as a
// sub-threshold no-suggestion with a rationale.
type Suggestion struct {
	TMDBID     int    `json:"tmdb_id"`
	Title      string `json:"title"`
	Year       int    `json:"year"`
	Confidence int    `json:"confidence"`
	Reasoning  string `json:"reasoning"`
	Promoted   bool   `json:"promoted"`
}

// ErrLLMDisabled is returned by Match when the matcher's llm client is
// nil — i.e. LLM_ENABLED=false at startup. The wiring in main.go avoids
// constructing the matcher in this case, so reaching this error means a
// caller invoked Match on a half-initialized matcher. Worth surfacing so
// the call site can fall through to a no-op rather than panic.
var ErrLLMDisabled = errors.New("ai matcher: llm client not configured")

// AIMatcher coordinates TMDB candidate fetching, LLM ranking, and
// auto-promotion. Safe for concurrent use — every dependency is itself
// safe for concurrent use and no internal mutable state is kept.
//
// autoThreshold is captured at construction; tuning AI_MATCH_AUTO_THRESHOLD
// requires a restart, matching the precedent set by MATCH_AUTO_THRESHOLD
// in the heuristic enricher.
type AIMatcher struct {
	llm           *llm.Client
	tmdb          *metadata.TMDBClient
	enricher      *metadata.Enricher
	queries       *db.Queries
	autoThreshold int
}

// NewAIMatcher constructs a matcher. The caller is responsible for nil
// guards — passing a nil llm/tmdb/enricher will cause Match to panic on
// dependency dereference, but in practice main.go only constructs the
// matcher inside the `if cfg.LLM.Enabled` block where all three are
// guaranteed non-nil.
func NewAIMatcher(llmClient *llm.Client, tmdb *metadata.TMDBClient, enricher *metadata.Enricher, queries *db.Queries, autoThreshold int) *AIMatcher {
	if autoThreshold <= 0 || autoThreshold > 100 {
		autoThreshold = 90
	}
	return &AIMatcher{
		llm:           llmClient,
		tmdb:          tmdb,
		enricher:      enricher,
		queries:       queries,
		autoThreshold: autoThreshold,
	}
}

// AutoThreshold returns the configured auto-promotion confidence floor.
// Exposed for the admin endpoint's status response so operators can see
// what the matcher is actually using (vs the env-default).
func (m *AIMatcher) AutoThreshold() int { return m.autoThreshold }

// Match runs the full pipeline for one item: fetch TMDB candidates, ask
// the LLM, persist the suggestion, auto-promote if confident enough.
// Returns the suggestion (may be nil when TMDB returned zero candidates
// or the LLM call failed) and an error.
//
// Errors are returned for caller logging. The "evaluated" timestamp gets
// stamped on every code path that completed an LLM call (success or
// LLM-side error), so the backfill worker doesn't re-process the same
// item forever. Two exceptions:
//
//   - TMDB fetch failure: not stamped, so the next backfill pass retries
//     the transient blip (rate-limit, network).
//   - Parent context cancelled (shutdown): not stamped, so the next boot
//     gets a clean retry — see deep-debugger Bug 7.5.
//
// Match also early-returns when the item's match_status has already been
// flipped to 'matched' between enqueue and processing (e.g. concurrent
// ManualMatch HTTP call) — see deep-debugger Bug 7.1. This avoids the
// race where the AI matcher would overwrite an operator's manual choice.
func (m *AIMatcher) Match(ctx context.Context, item *models.MediaItem) (*Suggestion, error) {
	if m == nil || m.llm == nil {
		return nil, ErrLLMDisabled
	}
	if item == nil {
		return nil, fmt.Errorf("ai matcher: nil item")
	}
	// Early-return defense against the inline-queue-vs-manual-match
	// race. Callers that fetched the item with the new (post-2026-05-25)
	// GetMediaItem will have MatchStatus populated; older call sites
	// pass an item from the scanner where MatchStatus is "" — those
	// reach the LLM regardless, which is the same as the old behavior.
	if item.MatchStatus == matchStatusMatched {
		slog.Debug("ai matcher: skipping, item already matched",
			"item_id", item.ID, "title", item.Title)
		return nil, nil
	}

	candidates, err := m.fetchCandidates(ctx, item)
	if err != nil {
		// Do NOT mark evaluated — TMDB blip should be retried on the
		// next backfill pass. The rate-limited tmdb client already
		// handles 429s internally; reaching here means something more
		// fundamental (network, auth) and the operator wants to retry.
		return nil, fmt.Errorf("fetch candidates: %w", err)
	}
	if len(candidates) == 0 {
		// Evaluated → no candidates → no suggestion. Stamp ran_at so the
		// backfill doesn't keep paying TMDB for nothing.
		m.markEvaluated(ctx, item.ID, "no tmdb candidates")
		slog.Debug("ai matcher: no tmdb candidates",
			"item_id", item.ID, "title", item.Title, "year", item.Year)
		return nil, nil
	}

	llmCtx, cancel := context.WithTimeout(ctx, aiMatchBudget)
	defer cancel()

	raw, err := m.llm.ChatJSON(llmCtx, aiMatchSystem, buildMatchPrompt(item, candidates), aiMatchSchema)
	if err != nil {
		// Distinguish parent-context-cancelled (shutdown) from a real
		// LLM failure. If the parent ctx is done, don't stamp evaluated
		// — the next boot's backfill should retry this item rather than
		// permanently skip it because we got Ctrl-C'd at the wrong
		// moment (deep-debugger Bug 7.5).
		if ctx.Err() != nil {
			return nil, fmt.Errorf("llm chat (shutdown): %w", err)
		}
		// Real LLM timeout / 500 / decode error. Mark evaluated so we
		// don't spin; operator can re-trigger via the admin endpoint
		// after fixing whatever's wrong.
		m.markEvaluated(ctx, item.ID, "llm failure")
		return nil, fmt.Errorf("llm chat: %w", err)
	}

	sug, err := parseMatchResponse(raw, candidates)
	if err != nil {
		// Parse failure — most often a hallucinated tmdb_id outside the
		// candidate set. Same mark-evaluated semantics; if the operator
		// suspects a model issue they can swap LLM_CHAT_MODEL and
		// re-trigger.
		m.markEvaluated(ctx, item.ID, "parse failure")
		return nil, fmt.Errorf("parse: %w (raw_len=%d)", err, len(raw))
	}

	// Persist suggestion BEFORE the (potentially long) auto-promote call so
	// the operator sees what the AI picked even if EnrichByTMDBID later
	// fails on TMDB rate-limit / network hiccup.
	if err := m.queries.UpdateAISuggestion(ctx, item.ID, suggestionToUpdate(sug)); err != nil {
		return sug, fmt.Errorf("persist suggestion: %w", err)
	}

	if sug.TMDBID > 0 && sug.Confidence >= m.autoThreshold {
		// Second concurrent-match check, AFTER the LLM call but BEFORE
		// the auto-promote. Closes the window where a ManualMatch HTTP
		// call landed during our 5-30s LLM round-trip and we'd otherwise
		// clobber their choice (deep-debugger Bug 3.2). Skip silently —
		// the suggestion is saved as audit trail.
		current, err := m.queries.GetMediaItem(ctx, item.ID)
		if err == nil && current != nil && current.MatchStatus == matchStatusMatched {
			slog.Info("ai matcher: skipping auto-promote, item matched concurrently",
				"item_id", item.ID, "tmdb_id", sug.TMDBID)
			return sug, nil
		}
		// Reuse the existing manual-match enrichment path. EnrichByTMDBID
		// sets match_status='matched' AND fully populates poster/cast/
		// genres/episodes — bit-for-bit identical to a human clicking
		// "approve" in the admin UI.
		if _, err := m.enricher.EnrichByTMDBID(ctx, item, sug.TMDBID, string(item.Type)); err != nil {
			slog.Warn("ai matcher: auto-promote failed",
				"item_id", item.ID, "tmdb_id", sug.TMDBID, "error", err)
			// Suggestion is already saved; the operator can still
			// approve via the existing ManualMatch endpoint.
			return sug, nil
		}
		sug.Promoted = true
		slog.Info("ai matcher: auto-promoted",
			"actor", "ai_matcher",
			"item_id", item.ID, "title", item.Title,
			"tmdb_id", sug.TMDBID, "confidence", sug.Confidence)
	} else if sug.TMDBID > 0 {
		slog.Debug("ai matcher: suggestion below auto-threshold",
			"item_id", item.ID, "title", item.Title,
			"tmdb_id", sug.TMDBID, "confidence", sug.Confidence,
			"threshold", m.autoThreshold)
	}

	return sug, nil
}

// markEvaluated stamps ai_match_ran_at without touching the suggestion
// columns. Wraps MarkAIEvaluated with consistent error logging so the
// call sites in Match() stay readable. The `reason` parameter is
// log-only — it doesn't get persisted, since the absence of a suggestion
// is itself the signal.
func (m *AIMatcher) markEvaluated(ctx context.Context, itemID int64, reason string) {
	if err := m.queries.MarkAIEvaluated(ctx, itemID); err != nil {
		slog.Warn("ai matcher: mark evaluated failed",
			"item_id", itemID, "reason", reason, "error", err)
	}
}

// RetryAutoPromote re-attempts the EnrichByTMDBID call for an item whose
// AI suggestion is at-or-above the auto-promote threshold but never made
// it past 'needs_review' status. This is the recovery path for the bug
// the operator hit on aurorapro.app: a 95%-confident Sneetches pick
// sat as a "suggested" row because TMDB returned an error during the
// original auto-promote attempt, and the matcher never tried again.
//
// No LLM call — the AI's pick is already cached on the row. We trust
// what the LLM said (it cleared the threshold once; nothing has changed
// about the item or the candidate set). We just need TMDB to cooperate.
//
// Returns (true, nil) when the promote succeeded (item is now matched).
// Returns (false, nil) when we declined to retry (concurrent ManualMatch
// already matched the row, or the item's suggestion fields are no longer
// auto-eligible — e.g. operator manually lowered the confidence column).
// Returns (false, err) when EnrichByTMDBID failed again — caller logs
// and moves on. The row stays flagged with its suggestion intact, so
// the operator can still manually accept (or the next boot's retry pass
// will try once more if TMDB has recovered).
func (m *AIMatcher) RetryAutoPromote(ctx context.Context, item *models.MediaItem) (bool, error) {
	if m == nil || m.enricher == nil {
		return false, fmt.Errorf("ai matcher: enricher not configured")
	}
	if item == nil || item.AISuggestedTMDBID == nil || *item.AISuggestedTMDBID <= 0 {
		return false, nil // nothing to retry against
	}
	confidence := 0
	if item.AIMatchConfidence != nil {
		confidence = *item.AIMatchConfidence
	}
	if confidence < m.autoThreshold {
		return false, nil // no longer eligible (e.g. threshold raised since)
	}

	// Concurrent-match defense — same shape as Match()'s pre-promote
	// guard. If a ManualMatch landed between query and now we MUST
	// NOT overwrite it. Re-fetch since the queue-paged copy may be
	// stale (the predicate matched at fetch-time but the row could
	// have flipped seconds later via the manual-match UI).
	current, err := m.queries.GetMediaItem(ctx, item.ID)
	if err == nil && current != nil && current.MatchStatus == matchStatusMatched {
		slog.Info("ai matcher: retry skipped, item matched concurrently",
			"item_id", item.ID, "tmdb_id", *item.AISuggestedTMDBID)
		return false, nil
	}

	tmdbID := *item.AISuggestedTMDBID
	if _, err := m.enricher.EnrichByTMDBID(ctx, item, tmdbID, string(item.Type)); err != nil {
		// Don't unstamp ai_match_ran_at on retry failure — the
		// suggestion is still valid, just unfilled. Operator can
		// manually accept; the next backfill retry pass will try
		// once more (boot-bounded so it doesn't loop forever).
		return false, fmt.Errorf("retry enrich: %w", err)
	}
	slog.Info("ai matcher: retry auto-promoted",
		"actor", "ai_matcher",
		"item_id", item.ID, "title", item.Title,
		"tmdb_id", tmdbID, "confidence", confidence)
	return true, nil
}

// fetchCandidates queries TMDB for up to aiMatchCandidateMax candidates
// for the item. Mirrors the enricher's title-then-no-year retry (see
// enricher.go:136 and :216) — if the year-constrained search returns
// nothing, retry without year because the filename year is often wrong
// (release year vs original air date, etc.).
//
// Returns a slice capped at aiMatchCandidateMax. TMDB's own ranking is
// preserved (most-popular first), which is the same heuristic the
// enricher's BestMatch uses; the LLM only needs to disambiguate the top
// of the list, not the entire long tail.
func (m *AIMatcher) fetchCandidates(ctx context.Context, item *models.MediaItem) ([]metadata.TMDBMovieTV, error) {
	cleanTitle := metadata.CleanTitle(item.Title)
	if cleanTitle == "" {
		return nil, nil // nothing searchable — caller handles as "no candidates"
	}

	var results *metadata.TMDBSearchResult
	var err error
	switch item.Type {
	case models.MediaMovie:
		results, err = m.tmdb.SearchMovies(ctx, cleanTitle, item.Year)
		if err != nil {
			return nil, fmt.Errorf("search movies: %w", err)
		}
		if len(results.Results) == 0 && item.Year > 0 {
			results, err = m.tmdb.SearchMovies(ctx, cleanTitle, 0)
			if err != nil {
				return nil, fmt.Errorf("search movies retry: %w", err)
			}
		}
	case models.MediaShow:
		results, err = m.tmdb.SearchTV(ctx, cleanTitle, item.Year)
		if err != nil {
			return nil, fmt.Errorf("search tv: %w", err)
		}
		if len(results.Results) == 0 && item.Year > 0 {
			results, err = m.tmdb.SearchTV(ctx, cleanTitle, 0)
			if err != nil {
				return nil, fmt.Errorf("search tv retry: %w", err)
			}
		}
	default:
		return nil, fmt.Errorf("unknown media type: %s", item.Type)
	}

	if results == nil || len(results.Results) == 0 {
		return nil, nil
	}

	n := len(results.Results)
	if n > aiMatchCandidateMax {
		n = aiMatchCandidateMax
	}
	return results.Results[:n], nil
}

// suggestionToUpdate converts the matcher's domain Suggestion into the
// DB-layer AISuggestionUpdate. Lives here (not in db/) so the boundary
// type stays free of matcher-specific concerns; the conversion handles
// the nil-pointer dance for the "evaluated, no suggestion" case.
//
// Two clamping behaviors worth flagging:
//
//   - Reasoning is truncated to 280 chars so a runaway model can't push a
//     multi-KB string into the TEXT column. We don't enforce this in the
//     system prompt's "<= 140 chars" rule because models violate it;
//     clamping here is cheaper than adding a DB constraint.
//   - Year is clamped to SMALLINT range. parseMatchResponse pulls Year
//     from the TMDB candidate (which is bounded), but if a future change
//     starts using the model's own year emission, an out-of-range year
//     would fail the UPDATE with "numeric overflow" — see deep-debugger
//     Bug 2.2. Clamp defense-in-depth.
//
// Confidence is ALWAYS populated (including 0) so the admin UI can
// distinguish "AI explicitly rejected with 0% confidence" from "AI never
// evaluated this dimension" (deep-debugger Bug 4.1). The TMDBID==nil
// signal carries "no suggestion to act on."
func suggestionToUpdate(s *Suggestion) *db.AISuggestionUpdate {
	if s == nil {
		return nil
	}
	u := &db.AISuggestionUpdate{}
	if s.TMDBID > 0 {
		tmdbID := s.TMDBID
		title := s.Title
		year := s.Year
		// SMALLINT range guard. Real TMDB years are 1880-2030ish;
		// anything outside this is a model glitch.
		if year < 0 {
			year = 0
		}
		if year > 32767 {
			year = 32767
		}
		u.TMDBID = &tmdbID
		u.Title = &title
		u.Year = &year
	}
	// Always populate confidence — see header comment. Clamp to [0,100]
	// even though parseMatchResponse already does; defense in depth in
	// case a future caller bypasses the parser.
	conf := s.Confidence
	if conf < 0 {
		conf = 0
	}
	if conf > 100 {
		conf = 100
	}
	u.Confidence = &conf
	if s.Reasoning != "" {
		const maxReasoning = 280
		r := s.Reasoning
		if len(r) > maxReasoning {
			r = r[:maxReasoning]
		}
		u.Reasoning = &r
	}
	return u
}
