package recommender

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/llmjson"
	"github.com/aurora-media/aurora/internal/models"
)

// Phase 4: LLM-generated reasons for the flat "More like what you watched"
// rail. The rail's job has historically been "fast and reliable" — sub-
// 100ms per request. Adding a synchronous LLM call would push that to 10-
// 20s on every cache miss, which is a UX regression even if cached.
//
// The pattern we use instead is ASYNC FILL with a per-item reason cache:
//
//   1. RailFor builds the rail at the existing speed (centroid + MMR +
//      anchor). No LLM in the hot path.
//   2. We look up cached reasons (keyed per profile+item) and attach them
//      to each rail item.
//   3. If any items are missing a reason, we fire a SINGLE background
//      goroutine per profile to generate them. The user's first page
//      load shows anchor captions ("Because you watched X") on every
//      card. Once the background fill completes (~15s), the cache is
//      populated.
//   4. The user's NEXT page load attaches the cached reasons to those
//      items and the card captions become the LLM's grounded reasons
//      instead of the anchor fallback.
//
// Net effect: the rail still loads sub-100ms always. Reasons arrive
// "eventually consistent" within one page reload after first view. No
// user ever sits waiting for an LLM call on this surface.

const (
	// railReasonTTL is how long a per-(profile, item) reason stays valid.
	// Reasons are essentially static — an item is recommended because of
	// the user's taste profile, which doesn't shift dramatically inside a
	// week. 24h matches the hero pool's TTL for consistency.
	railReasonTTL = 24 * time.Hour

	// railReasonBudget caps the async LLM call. Matches search rerank
	// (45s) — same prompt scale (~24 items), same expected response size.
	railReasonBudget = 45 * time.Second

	// railReasonMaxItems caps how many items we ask the LLM to write
	// reasons for in a single batch. The rail currently shows 24 items;
	// we cap at 30 for headroom. Past that, prompt size pushes total
	// latency past the budget on gpt-oss.
	railReasonMaxItems = 30
)

// railReasonKey is the cache key. (profileID, itemID) because the reason
// depends on the user's taste — "you'd enjoy this because of Severance"
// is meaningless to a user who never watched Severance.
type railReasonKey struct {
	profileID int64
	itemID    int64
}

// railReasonEntry is the cached payload. Just the reason text + when we
// stored it (for TTL eviction).
type railReasonEntry struct {
	reason  string
	addedAt time.Time
}

// railReasonArrayKeyAliases is the wrapper-key tolerance list for the
// LLM's response. Mirrors the pattern used in rerank.go and discover.go.
//
// History: we initially shipped the five "expected" keys (reasons, items,
// picks, results, captions). Production logs from gpt-oss:20b then surfaced
// a "no array found under any of [...]" parse error — the model had wrapped
// the array under a different top-level key. The extra five (output,
// response, data, recommendations, entries) cover the common gpt-oss
// alternatives without making the parser permissive enough to accept
// random nested objects. Add to this list rather than building deeper
// fallback logic — adding a string is a one-line review, and the cost of
// trying one more key in ExtractArray is a hash lookup.
var railReasonArrayKeyAliases = []string{
	"reasons", "items", "picks", "results", "captions",
	"output", "response", "data", "recommendations", "entries",
}

// railReasonSystem is the prompt for the async reason fill. Note the
// explicit "reasons should hint at WHY" instruction — without it, gpt-oss
// produces "you'd enjoy this" tautologies that add no signal over the
// anchor fallback.
const railReasonSystem = `You explain why a user might enjoy items their media server has recommended.

You will receive:
1. The user's recent watch anchors (titles they've been watching).
2. A numbered list of items the system has selected for them.

For each item, write ONE SENTENCE explaining why they'd enjoy it. Reasons must:
- Be ≤ 80 characters
- No quotes, no emojis
- Reference a SPECIFIC anchor when the connection is clear:
    GOOD: "Slow-burn sci-fi like Severance"
    GOOD: "Witty supernatural drama like Dead Boy Detectives"
- Otherwise describe what makes it a fit:
    GOOD: "Cult horror with comedic undertones"
- AVOID generic tautologies:
    BAD: "Matches your taste"
    BAD: "You might like this"
    BAD: "Similar to what you watch"

Respond with ONLY the JSON object. No preamble.`

// railReasonSchema constrains the output. Hosted Cloud models commonly
// ignore the schema (we've seen this throughout — same tolerant-parser
// strategy applies).
var railReasonSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"reasons": map[string]any{
			"type":     "array",
			"minItems": 1,
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"index":  map[string]any{"type": "integer"},
					"reason": map[string]any{"type": "string"},
				},
				"required": []string{"index", "reason"},
			},
		},
	},
	"required": []string{"reasons"},
}

// railReasonPickSpec is one parsed reason entry. Index is 1-based as
// emitted in the prompt; the caller bounds-checks against the input slice.
type railReasonPickSpec struct {
	Index  int
	Reason string
}

// attachCachedReasons populates item.Reason from the cache when present
// (and not expired). Items without a cached reason are left alone — their
// existing NearestAnchor caption ("Because you watched X") continues to
// render via the frontend's card-reason fallback chain.
//
// IMPORTANT: items are already shallow-copied by RailFor's annotateItems
// pass, so writing Reason here doesn't mutate any shared candidate.
func (h *Hero) attachCachedReasons(profileID int64, items []*models.MediaItem) {
	if len(items) == 0 {
		return
	}
	now := time.Now()
	for _, it := range items {
		if it == nil {
			continue
		}
		key := railReasonKey{profileID: profileID, itemID: it.ID}
		v, ok := h.reasonCache.Load(key)
		if !ok {
			continue
		}
		entry := v.(railReasonEntry)
		if now.Sub(entry.addedAt) > railReasonTTL {
			// Expired — drop from cache and skip. Lazy eviction is fine;
			// the cache is bounded by item count which is bounded by
			// catalog size, not user behavior.
			h.reasonCache.Delete(key)
			continue
		}
		if entry.reason != "" {
			it.Reason = entry.reason
		}
	}
}

// maybeFillReasonsAsync kicks off a background LLM call to generate
// reasons for any items lacking one. At most one fill is in flight per
// profile at a time — concurrent rail renders for the same user collapse
// to a single LLM call.
//
// The async fill uses a DETACHED context (not the request's ctx) because
// the rail HTTP request will have long returned by the time the LLM
// answers. Same pattern as the embedder's WithoutCancel write protection.
func (h *Hero) maybeFillReasonsAsync(profileID int64, items []*models.MediaItem) {
	if h.llm == nil || len(items) == 0 {
		return
	}

	// Skip if no items need filling. Pure cache-hit case.
	needsFill := false
	for _, it := range items {
		if it != nil && it.Reason == "" {
			needsFill = true
			break
		}
	}
	if !needsFill {
		return
	}

	// Single-inflight guard: only one fill goroutine per profile.
	// LoadOrStore returns the previous value if one existed, so if we
	// observe `loaded == true` someone else is already filling and we
	// silently bail. They'll populate the cache; our next request reads it.
	if _, loaded := h.reasonInflight.LoadOrStore(profileID, struct{}{}); loaded {
		return
	}

	// Snapshot inputs the goroutine needs. Anchors are pulled separately
	// inside the goroutine because we don't have them in scope here, and
	// the rail's existing fast path doesn't fetch them anyway.
	itemSnapshot := make([]*models.MediaItem, 0, len(items))
	for _, it := range items {
		if it != nil && it.Reason == "" {
			itemSnapshot = append(itemSnapshot, it)
			if len(itemSnapshot) >= railReasonMaxItems {
				break
			}
		}
	}
	if len(itemSnapshot) == 0 {
		// Race with the cache-hit check above (e.g. another goroutine
		// just populated). Cleanup the inflight marker and bail.
		h.reasonInflight.Delete(profileID)
		return
	}

	go h.fillReasonsBackground(profileID, itemSnapshot)
}

// fillReasonsBackground is the goroutine body. Pulls anchors, builds the
// prompt, calls the LLM, parses, and populates the per-item cache. Any
// failure is logged at Warn and silently dropped — the next request just
// re-tries the fill.
func (h *Hero) fillReasonsBackground(profileID int64, items []*models.MediaItem) {
	// Always clear the inflight marker on exit so the next call can try
	// again. Defer at the very top to cover all early returns.
	defer h.reasonInflight.Delete(profileID)

	ctx, cancel := context.WithTimeout(context.Background(), railReasonBudget)
	defer cancel()

	// Pull anchors for grounding. Failure is non-fatal — we can still
	// produce reasons, just without anchor-specific grounding.
	anchors, err := h.q.RecentTasteAnchors(ctx, profileID, 5)
	if err != nil {
		slog.Warn("rail reasons: anchor fetch failed", "profile", profileID, "error", err)
	}

	prompt := buildRailReasonPrompt(anchors, items)
	// Fast model — this is a frequent, latency-sensitive async fill. Native
	// /api/chat (the flat reasons schema already works there).
	raw, err := h.llm.ChatJSONWith(ctx, h.llm.ChatModelFast(), railReasonSystem, prompt, railReasonSchema, false)
	if err != nil {
		slog.Warn("rail reasons: LLM call failed", "profile", profileID, "error", err)
		return
	}

	specs, err := parseRailReasonResponse(raw)
	if err != nil {
		// Log a snippet of the raw response so we can identify the actual
		// top-level key gpt-oss used and decide whether to add it to
		// railReasonArrayKeyAliases. 500 chars covers the JSON header +
		// first one or two entries — enough to see the shape without
		// bloating logs with full overview text. Newlines are stripped
		// so the log line stays single-line for grep-friendliness.
		snippet := raw
		if len(snippet) > 500 {
			snippet = snippet[:500]
		}
		snippet = strings.ReplaceAll(snippet, "\n", " ")
		slog.Warn("rail reasons: parse failed",
			"profile", profileID, "error", err,
			"raw_len", len(raw), "raw_snippet", snippet)
		return
	}

	now := time.Now()
	stored := 0
	for _, s := range specs {
		idx := s.Index - 1
		if idx < 0 || idx >= len(items) {
			continue
		}
		reason := strings.TrimSpace(s.Reason)
		if reason == "" {
			continue
		}
		h.reasonCache.Store(railReasonKey{
			profileID: profileID,
			itemID:    items[idx].ID,
		}, railReasonEntry{
			reason:  reason,
			addedAt: now,
		})
		stored++
	}
	slog.Debug("rail reasons: fill complete",
		"profile", profileID, "items", len(items), "stored", stored)
}

// buildRailReasonPrompt formats the user message: anchors followed by a
// numbered item list. Same sanitization pattern as the other LLM-bound
// prompts in the codebase.
func buildRailReasonPrompt(anchors []db.TasteAnchor, items []*models.MediaItem) string {
	var b strings.Builder
	if len(anchors) > 0 {
		b.WriteString("Recently watched:\n")
		for _, a := range anchors {
			fmt.Fprintf(&b, "- %s", sanitizePromptText(a.Title, 120))
			if a.Year > 0 {
				fmt.Fprintf(&b, " (%d)", a.Year)
			}
			fmt.Fprintf(&b, " [%s]", a.Type)
			// QA BUG-010 — mirror buildRerankPrompt's genre grounding
			// so this LLM also has real anchor metadata instead of
			// training-data guesses.
			if len(a.Genres) > 0 {
				gs := a.Genres
				if len(gs) > 4 {
					gs = gs[:4]
				}
				fmt.Fprintf(&b, " — %s", sanitizePromptText(strings.Join(gs, ", "), 80))
			}
			b.WriteByte('\n')
		}
		b.WriteByte('\n')
	}
	b.WriteString("Items to explain:\n")
	for i, it := range items {
		fmt.Fprintf(&b, "%d. %s", i+1, sanitizePromptText(it.Title, 120))
		if it.Year > 0 {
			fmt.Fprintf(&b, " (%d)", it.Year)
		}
		fmt.Fprintf(&b, " [%s]", it.Type)
		if len(it.Genres) > 0 {
			fmt.Fprintf(&b, " genres=%s",
				sanitizePromptText(strings.Join(it.Genres, ","), 100))
		}
		if it.Overview != "" {
			fmt.Fprintf(&b, " — %s", sanitizePromptText(it.Overview, 180))
		}
		b.WriteByte('\n')
	}
	return b.String()
}

// parseRailReasonResponse decodes the LLM's reasons array, tolerating the
// same shape variants as search/discover parsers: wrapper-key aliases,
// bare top-level array, markdown fences, integer-as-string indices.
//
// Additional tolerance for gemma3:12b: that model frequently "compresses"
// the schema by collapsing the [{"index": N, "reason": "..."}] array into a
// flat object {"N": "reason"} where the key IS the 1-based index. We detect
// that shape via parseRailReasonsFlatMap and accept it as equivalent — same
// information, fewer levels of nesting. If the standard path fails, we try
// the flat-map path before bubbling the error up; if both fail, we surface
// the original error (more diagnostic, since it lists the alias keys tried).
func parseRailReasonResponse(raw string) ([]railReasonPickSpec, error) {
	arr, err := llmjson.ExtractArray(raw, railReasonArrayKeyAliases)
	if err != nil {
		if specs := parseRailReasonsFlatMap(raw); len(specs) > 0 {
			return specs, nil
		}
		return nil, err
	}
	out := make([]railReasonPickSpec, 0, len(arr))
	for _, item := range arr {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		idx, hasIdx := llmjson.PickInt(obj, "index")
		if !hasIdx {
			idx, hasIdx = llmjson.PickInt(obj, "id")
		}
		if !hasIdx {
			continue
		}
		reason, _ := obj["reason"].(string)
		reason = strings.TrimSpace(reason)
		if reason == "" {
			continue
		}
		out = append(out, railReasonPickSpec{Index: idx, Reason: reason})
	}
	return out, nil
}

// parseRailReasonsFlatMap detects gemma3:12b's "compressed" output shape:
// {"1": "reason1", "2": "reason2", ...} where each key is the 1-based
// index as a string and each value is the reason text. Returns nil (not an
// empty slice) if the shape doesn't match — caller distinguishes "not this
// shape" from "this shape but empty".
//
// Gating rules (all must hold):
//   - Top-level JSON decodes as a flat object
//   - At least one key is a positive integer string
//   - Every key parses as a positive integer string (no mixed schemas)
//   - Every value is a string
//
// The all-keys-numeric guard is deliberate: a response like
// {"reasons": [...], "stray": "..."} would not pass, so we never
// misinterpret a partially-correct shape as the flat-map form.
func parseRailReasonsFlatMap(raw string) []railReasonPickSpec {
	cleaned := llmjson.StripFences(raw)
	var top map[string]any
	if err := json.Unmarshal([]byte(cleaned), &top); err != nil {
		return nil
	}
	if len(top) == 0 {
		return nil
	}
	out := make([]railReasonPickSpec, 0, len(top))
	for k, v := range top {
		idx, err := strconv.Atoi(k)
		if err != nil || idx <= 0 {
			return nil
		}
		reason, ok := v.(string)
		if !ok {
			return nil
		}
		reason = strings.TrimSpace(reason)
		if reason == "" {
			continue
		}
		out = append(out, railReasonPickSpec{Index: idx, Reason: reason})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
