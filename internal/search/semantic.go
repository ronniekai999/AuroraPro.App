// Package search implements natural-language media search on top of the
// catalog embeddings produced by internal/embedding.
//
// AI-first pipeline (Phase 7):
//
//	query ─► classify (regex)
//	          ├─► literal     → caller falls back to trigram path
//	          └─► descriptive → LLM parser (HyDE + filters)
//	                            └─► embed(hyde_overview) ─► vector recall (50)
//	                                                        ├─► dedup by tmdb_id
//	                                                        ├─► annotate genres
//	                                                        ├─► cap at rerankInputCap
//	                                                        └─► LLM rerank with reasons
//
// Why AI-first: the previous "many SQL filters + hybrid score" approach
// failed on audience-tier mismatches (recommending The Powerpuff Girls for
// "shows like Buffy"). Moving filtering into the LLM lets the model judge
// tier/vibe/audience — things hard to express in SQL. We keep the vector
// recall broad (50 items) and let the LLM curate.
package search

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/embedding"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/llmjson"
	"github.com/aurora-media/aurora/internal/models"
)

// vectorRecallSize is how many candidates we pull from pgvector before the
// LLM rerank stage. 50 is broad enough that the rerank usually finds 5–10
// strong matches and drops the rest; smaller pools risk the rerank returning
// "nothing matches" when the answer was at rank 45.
const vectorRecallSize = 50

// queryParseBudget caps the parser LLM call. Slow parsers degrade the whole
// search latency, and the fallback ("embed the raw query") is acceptable.
const queryParseBudget = 8 * time.Second

// Searcher coordinates the LLM-driven natural-language search pipeline.
// Safe for concurrent use; the parse cache and HTTP client both are.
type Searcher struct {
	llm   *llm.Client
	q     *db.Queries
	cache *parseCache
}

// New constructs a Searcher. The cache TTL is fixed (10 min) — long enough to
// dedupe burst typing, short enough that newly-added items show up promptly
// on repeat queries.
func New(llmClient *llm.Client, q *db.Queries) *Searcher {
	return &Searcher{
		llm:   llmClient,
		q:     q,
		cache: newParseCache(256, 10*time.Minute),
	}
}

// IsLiteralQuery returns true for queries that are clearly title lookups —
// short, no question words, no relational phrases. Callers should route these
// to their existing trigram search instead of paying the LLM round-trip.
//
// Examples that return true:  "Inception", "the matrix", "severance s2"
// Examples that return false: "movies like Severance", "feel-good 90s sci-fi",
//
//	"what should I watch tonight"
func IsLiteralQuery(query string) bool {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return true
	}
	if relationalRE.MatchString(q) {
		return false
	}
	tokens := strings.Fields(q)
	return len(tokens) <= 3
}

var relationalRE = regexp.MustCompile(
	`\b(like|similar|kind of|sort of|feels? like|reminds? me|something|anything|good|best|recommend|watch|show me|find me|should|with|without|but|funny|sad|scary|dark|light|cozy|wholesome|gritty|underrated)\b`,
)

// ParsedQuery is the structured output of the LLM query parser. All fields
// are optional — populate only what the user implied.
//
// SimilarToTitles was used by the old hybrid-score Search() to re-embed
// reference titles via blendWithReferences. The AI-first rewrite dropped
// that logic; the field stays on the struct (and in eval_test.go) but is
// no longer asked for in hydeQuerySchema, so models don't waste tokens
// generating values we'd ignore.
type ParsedQuery struct {
	Intent          string   `json:"intent"`
	Genres          []string `json:"genres"`
	YearMin         int      `json:"year_min"`
	YearMax         int      `json:"year_max"`
	RuntimeMaxMin   int      `json:"runtime_max_min"`
	MediaType       string   `json:"media_type"`
	SimilarToTitles []string `json:"similar_to_titles,omitempty"`
	HydeOverview    string   `json:"hyde_overview"`
}

// UnmarshalJSON tolerates the empty-string-for-int quirk that gpt-oss:20b
// (and some other hosted Cloud models) emit when no value applies. The
// schema sends `"year_min": ""` instead of omitting the field or sending
// 0, and the default int unmarshaler errors out with "cannot unmarshal
// string into Go struct field". We decode into a shadow struct with `any`
// for the numeric fields, then coerce — empty strings, JSON numbers, and
// string-encoded ints all become a plain int. Unknown shapes default to 0
// rather than failing the whole parse.
func (p *ParsedQuery) UnmarshalJSON(data []byte) error {
	type shadow struct {
		Intent          string   `json:"intent"`
		Genres          []string `json:"genres"`
		YearMin         any      `json:"year_min"`
		YearMax         any      `json:"year_max"`
		RuntimeMaxMin   any      `json:"runtime_max_min"`
		MediaType       string   `json:"media_type"`
		SimilarToTitles []string `json:"similar_to_titles"`
		HydeOverview    string   `json:"hyde_overview"`
	}
	var s shadow
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	p.Intent = s.Intent
	p.Genres = s.Genres
	p.MediaType = s.MediaType
	p.SimilarToTitles = s.SimilarToTitles
	p.HydeOverview = s.HydeOverview
	p.YearMin = coerceInt(s.YearMin)
	p.YearMax = coerceInt(s.YearMax)
	p.RuntimeMaxMin = coerceInt(s.RuntimeMaxMin)
	return nil
}

// coerceInt converts the JSON-decoded `any` to int, tolerating the shapes
// hosted models emit: float64 (standard JSON number), string (sometimes
// quoted ints), and the empty string (gpt-oss:20b's "no value" sentinel).
// NaN/Inf and unparseable strings become 0 so a single bad field doesn't
// fail the whole parse.
func coerceInt(v any) int {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		if t != t || t > 1e18 || t < -1e18 { // NaN check + sane bounds
			return 0
		}
		return int(t)
	case int:
		return t
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0
		}
		n, err := strconv.Atoi(s)
		if err != nil {
			return 0
		}
		return n
	}
	return 0
}

// Hit is one result with the LLM-generated reason populated when available.
// Score is no longer meaningful in the AI-first flow (the LLM's ordering IS
// the answer), but we keep the field for backward compatibility with the
// api.SemanticHit shape.
type Hit struct {
	Item   *models.MediaItem `json:"item"`
	Score  float64           `json:"score"`
	Reason string            `json:"reason,omitempty"`
}

// Search runs the full pipeline.
//
//   - Parser failure → fall back to embedding the raw query (no filters).
//   - Embed failure  → return error; caller falls back to trigram.
//   - Vector failure → return error.
//   - Rerank failure → return vector-ordered hits with no reasons.
func (s *Searcher) Search(ctx context.Context, query string, limit int) ([]Hit, *ParsedQuery, error) {
	if limit <= 0 {
		limit = 20
	}

	parsed, err := s.parseQuery(ctx, query)
	if err != nil {
		slog.Warn("query parse failed; falling back to raw embedding", "error", err)
		parsed = &ParsedQuery{Intent: "descriptive", HydeOverview: query}
	}

	embedText := parsed.HydeOverview
	if embedText == "" {
		embedText = query
	}

	queryVec, err := s.llm.Embed(ctx, embedText)
	if err != nil {
		return nil, parsed, fmt.Errorf("embed query: %w", err)
	}
	if queryVec == nil {
		return nil, parsed, fmt.Errorf("empty embedding for query")
	}

	// Vector recall: broad, lightly filtered. We DON'T pass genres/year filters
	// from the parser to the DB — the LLM rerank handles that downstream. Tight
	// SQL filters were the source of the "intersection produces empty results"
	// bug. The one filter we DO keep is media_type, and only when validated.
	filter := db.SemanticFilter{
		MediaType: validMediaType(parsed.MediaType),
	}

	hits, err := s.q.SemanticSearch(ctx, llm.FormatVector(queryVec), filter, vectorRecallSize)
	if err != nil {
		return nil, parsed, fmt.Errorf("vector search: %w", err)
	}
	if len(hits) == 0 {
		return nil, parsed, nil
	}

	// Promote SemanticHit to MediaItem list for dedup + genre annotation.
	items := make([]*models.MediaItem, len(hits))
	distByID := make(map[int64]float64, len(hits))
	for i, h := range hits {
		items[i] = h.Item
		distByID[h.Item.ID] = h.Distance
	}

	// Cross-library dedup FIRST: same TMDB-ID items in different libraries
	// collapse to one. Done before genre annotation because DeduplicateByTMDBID
	// may swap a winning "best" pointer that was not in the original input
	// slice — annotating before dedup wasted DB work AND left the dedup-
	// winner with empty Genres (so the rerank prompt got less signal).
	deduped, err := s.q.DeduplicateByTMDBID(ctx, items)
	if err != nil {
		slog.Warn("search: dedup failed (continuing without dedup)", "error", err)
		deduped = items
	}

	// Cap before rerank: Cloud chat models start failing past ~30 candidates.
	// We also cap before annotation so we don't pay genre lookups for items
	// the LLM will never see.
	if len(deduped) > rerankInputCap {
		deduped = deduped[:rerankInputCap]
	}

	// Genre annotate: the rerank prompt benefits from genres ("[TV-14]
	// genres=Drama,Sci-Fi"). One batched query, no N+1.
	if err := s.annotateGenres(ctx, deduped); err != nil {
		slog.Warn("search: genre annotate failed (continuing without genres)", "error", err)
	}

	// LLM rerank with reasons. On failure we degrade to vector order without
	// reasons rather than failing the whole search.
	picks, rerankErr := rerankSearchCandidates(ctx, s.llm, query, deduped)
	if rerankErr != nil {
		slog.Warn("search: rerank failed (using vector order)", "error", rerankErr)
		return vectorOrderHits(deduped, distByID, limit), parsed, nil
	}

	// Title-fallback via the shared helper. Seeds bare Title +
	// "Title (YEAR)" + their lowercase forms; gemma3:12b emits picks
	// with the year-suffixed form because that's how candidates appear
	// in the prompt, while c.Title stores just the bare title.
	// Consolidated implementation in internal/llmjson/title_resolver.go;
	// same helper drives hero and discover. Production log proof of
	// the bug: `pick_count=5` with `no resolvable picks` because every
	// pick had a year-suffixed title that didn't match the bare-Title
	// lookup before this consolidation.
	titleIdx := llmjson.BuildCandidateTitleIndex(deduped, func(c *models.MediaItem) (string, int) {
		return c.Title, c.Year
	})

	out := make([]Hit, 0, len(picks))
	used := make(map[int]bool, len(picks))
	for _, p := range picks {
		idx := p.Index - 1
		// Title-fallback when the model dropped the index. If we can't
		// resolve either way, skip the pick rather than guessing — a
		// wrong fuzzy match silently corrupts the result list.
		if (idx < 0 || idx >= len(deduped)) && p.Title != "" {
			if i, ok := llmjson.ResolveByTitle(titleIdx, p.Title); ok {
				idx = i
			}
		}
		if idx < 0 || idx >= len(deduped) || used[idx] {
			continue
		}
		used[idx] = true
		item := deduped[idx]
		out = append(out, Hit{
			Item:   item,
			Reason: p.Reason,
			Score:  scoreForHit(item.ID, distByID),
		})
		if len(out) >= limit {
			break
		}
	}

	// Two ways `out` can be empty here:
	//   (a) `picks` was empty — the LLM legitimately said "nothing matches".
	//       The rerank system prompt explicitly asks for that signal, and
	//       the right UX is "No results found", NOT a fallback to weak
	//       vector matches (which is exactly what the AI-first rewrite was
	//       meant to stop — recommending wrong-audience items because the
	//       vector said they were close).
	//   (b) `picks` was non-empty but every entry failed to resolve (no
	//       index, no id, and the title didn't match any candidate). This
	//       is a parser/model failure, not a legitimate empty. Fall back
	//       to vector order so the user gets something rather than nothing.
	//
	// Guarding on `len(picks) > 0` is what separates the two cases.
	if len(out) == 0 && len(picks) > 0 {
		slog.Warn("search: rerank yielded no resolvable picks (using vector order)",
			"pick_count", len(picks))
		return vectorOrderHits(deduped, distByID, limit), parsed, nil
	}
	return out, parsed, nil
}

// vectorOrderHits is the rerank-failure fallback: deduped items in their
// vector-recall order, no reasons. The Score field is filled from cosine
// distance so consumers that still depend on it (e.g. tests) keep working.
func vectorOrderHits(items []*models.MediaItem, distByID map[int64]float64, limit int) []Hit {
	if limit > len(items) {
		limit = len(items)
	}
	out := make([]Hit, limit)
	for i := 0; i < limit; i++ {
		item := items[i]
		out[i] = Hit{
			Item:  item,
			Score: scoreForHit(item.ID, distByID),
		}
	}
	return out
}

// scoreForHit converts a cosine distance in [0, 2] to a similarity in [0, 1].
//
// Returns 0 when the item's ID isn't in distByID — which happens after
// DeduplicateByTMDBID swaps a sibling pointer that wasn't in the original
// recall slice. Without this guard the swapped pointer would inherit the
// map's zero-value (distance = 0 → Score = 1.0), making a *non-best-match*
// look like a perfect-match in the response. Score is informational only,
// but emitting an honest 0 beats emitting a misleading 1.
func scoreForHit(id int64, distByID map[int64]float64) float64 {
	d, ok := distByID[id]
	if !ok {
		return 0
	}
	s := 1.0 - (d / 2.0)
	if s < 0 {
		s = 0
	}
	return s
}

// annotateGenres fills the .Genres slice on each item via one batched query.
// Failure is non-fatal — without genres the rerank prompt is slightly less
// informative but still works.
func (s *Searcher) annotateGenres(ctx context.Context, items []*models.MediaItem) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]int64, len(items))
	for i, it := range items {
		ids[i] = it.ID
	}
	byID, err := s.q.GetMediaGenresBatch(ctx, ids)
	if err != nil {
		return err
	}
	for _, it := range items {
		if g, ok := byID[it.ID]; ok {
			it.Genres = g
		}
	}
	return nil
}

func (s *Searcher) parseQuery(ctx context.Context, query string) (*ParsedQuery, error) {
	cacheKey := strings.ToLower(strings.TrimSpace(query))
	if cached, ok := s.cache.get(cacheKey); ok {
		return cached, nil
	}

	parseCtx, cancel := context.WithTimeout(ctx, queryParseBudget)
	defer cancel()

	raw, err := s.llm.ChatJSON(parseCtx, hydeParserSystem, query, hydeQuerySchema)
	if err != nil {
		return nil, err
	}
	cleaned := llmjson.StripFences(raw)
	var parsed ParsedQuery
	if err := json.Unmarshal([]byte(cleaned), &parsed); err != nil {
		// Cap the embedded raw output at 512 chars so a model with a long
		// "thinking" trace doesn't dump 100KB into a single log line via
		// the bubbled-up error.
		return nil, fmt.Errorf("decode parse output: %w (raw=%q)", err, snippetForErr(raw, 512))
	}
	if parsed.YearMin < 0 || parsed.YearMin > 2100 {
		parsed.YearMin = 0
	}
	if parsed.YearMax < 0 || parsed.YearMax > 2100 {
		parsed.YearMax = 0
	}
	if parsed.RuntimeMaxMin < 0 {
		parsed.RuntimeMaxMin = 0
	}
	// Normalize media_type ONCE before caching so we don't store garbage
	// strings like "tv_series" that we'd then have to re-validate on every
	// cache hit. Search() already calls validMediaType separately, but a
	// future caller reading parsed.MediaType (e.g. surfacing it to the UI)
	// won't know to re-validate. Belt-and-suspenders.
	parsed.MediaType = validMediaType(parsed.MediaType)
	s.cache.set(cacheKey, &parsed)
	return &parsed, nil
}

// snippetForErr caps an LLM raw-output string for safe inclusion in an
// error message. Mirrors the unexported helper in internal/llm but
// duplicated here so we don't widen that package's API for one caller.
func snippetForErr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "...(truncated)"
}

// Compile-time guard so a future refactor that drops embedding.CurrentVersion
// doesn't silently orphan this package. Free at runtime.
var _ = embedding.CurrentVersion

// --- parse cache: a tiny TTL+LRU hybrid ---

type parseCache struct {
	mu      sync.Mutex
	max     int
	ttl     time.Duration
	entries map[string]parseCacheEntry
	order   []string
}

type parseCacheEntry struct {
	value   *ParsedQuery
	addedAt time.Time
}

func newParseCache(max int, ttl time.Duration) *parseCache {
	return &parseCache{max: max, ttl: ttl, entries: make(map[string]parseCacheEntry)}
}

func (c *parseCache) get(key string) (*ParsedQuery, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	if time.Since(e.addedAt) > c.ttl {
		delete(c.entries, key)
		return nil, false
	}
	return e.value, true
}

func (c *parseCache) set(key string, v *ParsedQuery) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.entries[key]; exists {
		// Hot key — promote to tail so it's evicted last. Without this, a
		// query reparsed many times keeps its original position in `order`
		// and the LRU drops it while one-off queries survive. Linear scan
		// is fine: order is bounded at c.max (256 default).
		for i, k := range c.order {
			if k == key {
				c.order = append(c.order[:i], c.order[i+1:]...)
				break
			}
		}
	}
	c.order = append(c.order, key)
	c.entries[key] = parseCacheEntry{value: v, addedAt: time.Now()}
	// Cap-eviction. Skip stale order entries (already TTL-evicted from `entries`
	// by get()) so we don't drain order without freeing real cache slots, which
	// would defeat the size limit and let order grow unboundedly.
	for len(c.entries) > c.max && len(c.order) > 0 {
		oldest := c.order[0]
		c.order = c.order[1:]
		if _, live := c.entries[oldest]; live {
			delete(c.entries, oldest)
		}
	}
}
