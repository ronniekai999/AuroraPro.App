package recommender

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/models"
)

// TestIsLLMServerError covers the typed-error helper that gates discover's
// single-retry on cloud 500s. The client returns *llm.StatusError for every
// non-2xx (possibly wrapped with %w by intermediate layers); anything else —
// timeouts, parse failures, or a plain string that merely LOOKS like the old
// error format — must not trigger a retry.
func TestIsLLMServerError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil err", nil, false},
		{"500 typed", &llm.StatusError{Op: "chat", Status: 500, Body: `{"error":"Internal Server Error"}`}, true},
		{"502 typed", &llm.StatusError{Op: "chat", Status: 502, Body: "bad gateway"}, true},
		{"503 wrapped once", fmt.Errorf("rerank: %w", &llm.StatusError{Op: "chat", Status: 503, Body: "maintenance"}), true},
		{"400 typed (no retry)", &llm.StatusError{Op: "chat", Status: 400, Body: "malformed"}, false},
		{"401 typed (no retry)", &llm.StatusError{Op: "chat", Status: 401, Body: "unauthorized"}, false},
		{"string lookalike (no retry)", errors.New("ollama chat: status 500: not actually typed"), false},
		{"context deadline (no retry)", errors.New("ollama chat: context deadline exceeded"), false},
		{"parse failure (no retry)", errors.New("decode top-level: invalid character"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isLLMServerError(c.err); got != c.want {
				t.Errorf("isLLMServerError(%v) = %v, want %v", c.err, got, c.want)
			}
		})
	}
}

// makeCand builds a RailCandidate with the given id and explicit embedding
// (kept tiny for test clarity).
func makeCand(id int64, vec []float32) *db.RailCandidate {
	return &db.RailCandidate{
		Item:          &models.MediaItem{ID: id, Title: idToTitle(id)},
		EmbeddingText: llm.FormatVector(vec),
	}
}

func idToTitle(id int64) string {
	return string(rune('A'+(id-1))) + "-item"
}

// --------------------------------------------------------------------------
// cosineSimilarity
// --------------------------------------------------------------------------

func TestCosineSimilarity_Parallel(t *testing.T) {
	a := []float32{1, 0, 0}
	b := []float32{1, 0, 0}
	got := cosineSimilarity(a, b)
	if math.Abs(got-1.0) > 1e-6 {
		t.Errorf("parallel unit vectors: got %v, want 1.0", got)
	}
}

func TestCosineSimilarity_Orthogonal(t *testing.T) {
	a := []float32{1, 0, 0}
	b := []float32{0, 1, 0}
	got := cosineSimilarity(a, b)
	if math.Abs(got) > 1e-6 {
		t.Errorf("orthogonal vectors: got %v, want 0.0", got)
	}
}

func TestCosineSimilarity_Antiparallel(t *testing.T) {
	a := []float32{1, 0, 0}
	b := []float32{-1, 0, 0}
	got := cosineSimilarity(a, b)
	if math.Abs(got+1.0) > 1e-6 {
		t.Errorf("antiparallel: got %v, want -1.0", got)
	}
}

func TestCosineSimilarity_MismatchedLength(t *testing.T) {
	// Defensive against future dim changes — return 0 rather than panic.
	if got := cosineSimilarity([]float32{1, 0}, []float32{1, 0, 0}); got != 0 {
		t.Errorf("mismatched lengths: got %v, want 0", got)
	}
}

func TestCosineSimilarity_Empty(t *testing.T) {
	if got := cosineSimilarity(nil, nil); got != 0 {
		t.Errorf("empty: got %v, want 0", got)
	}
}

// --------------------------------------------------------------------------
// mmrDiversify
// --------------------------------------------------------------------------

func TestMMRDiversify_FewerThanK(t *testing.T) {
	cands := []*db.RailCandidate{
		makeCand(1, []float32{1, 0, 0}),
		makeCand(2, []float32{0, 1, 0}),
	}
	got := mmrDiversify(cands, []float32{1, 0, 0}, 0.7, 5)
	if len(got) != 2 {
		t.Fatalf("want 2 (all of input), got %d", len(got))
	}
}

func TestMMRDiversify_FirstPickIsMostSimilar(t *testing.T) {
	// Query is closer to cand 2 than cand 1; MMR's first pick should be cand 2.
	cands := []*db.RailCandidate{
		makeCand(1, []float32{0.5, 0.5, 0}), // sim to query ≈ 0.707
		makeCand(2, []float32{1, 0, 0}),     // sim to query = 1.0
		makeCand(3, []float32{0, 1, 0}),     // sim to query = 0.0
	}
	got := mmrDiversify(cands, []float32{1, 0, 0}, 0.7, 1)
	if len(got) != 1 || got[0].Item.ID != 2 {
		t.Fatalf("first pick: want id=2, got %+v", picksIDs(got))
	}
}

func TestMMRDiversify_DiversifiesNearDuplicates(t *testing.T) {
	// 4 cands, k=3. With λ=0.3 (diversity-biased — production default is
	// 0.7 which favors relevance), MMR should avoid the near-duplicate
	// of the first pick. We use a deliberately low λ here to demonstrate
	// the diversity term WORKS; at λ=0.7 it's intentionally subtle.
	//
	// Cand 1 and 2 are IDENTICAL embeddings — same direction, same
	// magnitude. Cand 3 is 60° from query; cand 4 is orthogonal (90°).
	// After picking cand 1 (simQ=1.0), MMR scoring:
	//   cand 2:  λ·1.0 − (1−λ)·1.0 = 2λ−1     (at λ=0.3: −0.4)
	//   cand 3:  λ·0.5 − (1−λ)·0.5 = 0.5(2λ−1)(at λ=0.3: −0.2)
	//   cand 4:  λ·0.0 − (1−λ)·0.0 = 0        (at λ=0.3:  0.0)
	// Cand 4 wins (score 0 > −0.2 > −0.4). MMR avoids the near-duplicate.
	cands := []*db.RailCandidate{
		makeCand(1, []float32{1, 0, 0}),
		makeCand(2, []float32{1, 0, 0}),       // IDENTICAL to cand 1
		makeCand(3, []float32{0.5, 0.866, 0}), // 60° from query (unit length)
		makeCand(4, []float32{0, 1, 0}),       // 90° from query (orthogonal)
	}
	got := mmrDiversify(cands, []float32{1, 0, 0}, 0.3, 3)
	if len(got) != 3 {
		t.Fatalf("want 3 picks, got %d", len(got))
	}
	// First pick: cand 1 OR cand 2 (both have simQ=1.0; ties resolved by
	// pool order → cand 1).
	if got[0].Item.ID != 1 {
		t.Errorf("first pick should be ID 1 (max simQ, pool-order tiebreak); got %d", got[0].Item.ID)
	}
	// Second pick should NOT be the near-duplicate.
	if got[1].Item.ID == 2 {
		t.Errorf("at λ=0.3 (diversity-biased), MMR should reject the identical-embedding near-duplicate; got cand 2 as 2nd pick. Order: %v", picksIDs(got))
	}
}

func TestMMRDiversify_HandlesUnparseable(t *testing.T) {
	// Items with malformed embeddings go to the fallback list — only
	// appended after parsed items are exhausted. To exercise that path
	// we need MORE unparseable items than (k − parseable_count) so the
	// fallback actually fires. With 2 parsed + 2 unparseable and k=3:
	//   pool has 2, MMR fills out[0..1] with parsed; out[2] comes from
	//   fallback. The "len(cands) <= k" early return doesn't fire here
	//   because cands=4 > k=3.
	cands := []*db.RailCandidate{
		makeCand(1, []float32{1, 0, 0}),
		{Item: &models.MediaItem{ID: 2}, EmbeddingText: "garbage"},
		makeCand(3, []float32{0, 1, 0}),
		{Item: &models.MediaItem{ID: 4}, EmbeddingText: "also-garbage"},
	}
	got := mmrDiversify(cands, []float32{1, 0, 0}, 0.7, 3)
	if len(got) != 3 {
		t.Fatalf("want 3 picks (2 parsed + 1 fallback), got %d", len(got))
	}
	// First two slots: parsed candidates. Cand 1 has simQ=1.0, cand 3 has
	// simQ=0.0; MMR picks cand 1 first, then cand 3 (last parsed standing).
	if got[0].Item.ID != 1 || got[1].Item.ID != 3 {
		t.Errorf("first two slots should be parsed candidates (1, 3); got %v", picksIDs(got))
	}
	// Third slot: top-up from fallback. Either cand 2 or cand 4 acceptable.
	if got[2].Item.ID != 2 && got[2].Item.ID != 4 {
		t.Errorf("third slot should be a fallback candidate (2 or 4); got %v", picksIDs(got))
	}
}

func TestMMRDiversify_AllUnparseable(t *testing.T) {
	cands := []*db.RailCandidate{
		{Item: &models.MediaItem{ID: 1}, EmbeddingText: "garbage1"},
		{Item: &models.MediaItem{ID: 2}, EmbeddingText: "garbage2"},
		{Item: &models.MediaItem{ID: 3}, EmbeddingText: "garbage3"},
	}
	got := mmrDiversify(cands, []float32{1, 0, 0}, 0.7, 2)
	if len(got) != 2 {
		t.Fatalf("want 2 from fallback, got %d", len(got))
	}
}

func TestMMRDiversify_QueryMagnitudeInvariant(t *testing.T) {
	// Regression: RailFor passes the raw BuildProfileVector centroid, which is
	// an AVG() of unit vectors and therefore SHORTER than unit length. Before
	// mmrDiversify normalized the query, that shrank the relevance term
	// (dot(unit, sub-unit)) while the diversity term stayed a true cosine —
	// so a diverse profile (short centroid) over-weighted diversity.
	//
	// Numbers at λ=0.7, k=2, query along x:
	//   A=(1,0,0) simQ=1.0 → first pick.
	//   B=(0.96,0.28,0) simQ=0.96, sim(B,A)=0.96 → 0.7·0.96 − 0.3·0.96 = 0.384
	//   C=(0,1,0)       simQ=0.0,  sim(C,A)=0.0  → 0.0
	//   → second pick is B (relevance wins).
	// With the query scaled to 0.2 and NO normalization, simQ compresses to
	// 0.2/0.192/0 and B scores 0.7·0.192 − 0.3·0.96 = −0.154 < 0 → C would
	// win, flipping the outcome on magnitude alone.
	cands := []*db.RailCandidate{
		makeCand(1, []float32{1, 0, 0}),
		makeCand(2, []float32{0.96, 0.28, 0}), // unit length: 0.96²+0.28²=1
		makeCand(3, []float32{0, 1, 0}),
	}
	unit := mmrDiversify(cands, []float32{1, 0, 0}, 0.7, 2)
	scaled := mmrDiversify(cands, []float32{0.2, 0, 0}, 0.7, 2)
	if len(unit) != 2 || unit[0].Item.ID != 1 || unit[1].Item.ID != 2 {
		t.Fatalf("unit query: want [1 2], got %v", picksIDs(unit))
	}
	if len(scaled) != 2 || scaled[0].Item.ID != unit[0].Item.ID || scaled[1].Item.ID != unit[1].Item.ID {
		t.Errorf("scaled query must pick identically to unit query; unit=%v scaled=%v",
			picksIDs(unit), picksIDs(scaled))
	}
}

func picksIDs(picks []*db.RailCandidate) []int64 {
	ids := make([]int64, len(picks))
	for i, p := range picks {
		ids[i] = p.Item.ID
	}
	return ids
}

// --------------------------------------------------------------------------
// attachNearestAnchor — shallow-copy invariant + parse failure tolerance
// --------------------------------------------------------------------------

func TestAttachNearestAnchor_Basic(t *testing.T) {
	cands := []*db.RailCandidate{
		makeCand(10, []float32{1, 0, 0}),
		makeCand(11, []float32{0, 1, 0}),
	}
	anchors := []*db.WatchAnchor{
		{Title: "Buffy", Year: 1997, Type: "show", EmbeddingText: llm.FormatVector([]float32{1, 0, 0})},
		{Title: "Severance", Year: 2022, Type: "show", EmbeddingText: llm.FormatVector([]float32{0, 1, 0})},
	}
	attachNearestAnchor(cands, anchors)
	if cands[0].Item.NearestAnchor == nil || cands[0].Item.NearestAnchor.Title != "Buffy" {
		t.Errorf("cand 10 should match Buffy; got %+v", cands[0].Item.NearestAnchor)
	}
	if cands[1].Item.NearestAnchor == nil || cands[1].Item.NearestAnchor.Title != "Severance" {
		t.Errorf("cand 11 should match Severance; got %+v", cands[1].Item.NearestAnchor)
	}
}

func TestAttachNearestAnchor_IndependentPointers(t *testing.T) {
	// Two candidates whose nearest anchor is the same should get DISTINCT
	// AnchorRef pointers, so mutating one can't affect the other.
	cands := []*db.RailCandidate{
		makeCand(10, []float32{1, 0, 0}),
		makeCand(11, []float32{0.9, 0.1, 0}), // also closest to anchor 0
	}
	anchors := []*db.WatchAnchor{
		{Title: "Buffy", Year: 1997, Type: "show", EmbeddingText: llm.FormatVector([]float32{1, 0, 0})},
	}
	attachNearestAnchor(cands, anchors)
	if cands[0].Item.NearestAnchor == cands[1].Item.NearestAnchor {
		t.Error("two cands matching the same anchor share a pointer; mutating one would leak to the other")
	}
	// Mutate one, verify the other is untouched.
	cands[0].Item.NearestAnchor.Title = "MUTATED"
	if cands[1].Item.NearestAnchor.Title == "MUTATED" {
		t.Error("AnchorRef pointer is shared — shallow-copy invariant broken")
	}
}

func TestAttachNearestAnchor_SkipsUnparseable(t *testing.T) {
	// Candidate with garbage embedding should get no anchor (silently
	// skipped) rather than crash or pick the wrong anchor.
	cands := []*db.RailCandidate{
		{Item: &models.MediaItem{ID: 1}, EmbeddingText: "garbage"},
		makeCand(2, []float32{1, 0, 0}),
	}
	anchors := []*db.WatchAnchor{
		{Title: "Buffy", EmbeddingText: llm.FormatVector([]float32{1, 0, 0})},
	}
	attachNearestAnchor(cands, anchors)
	if cands[0].Item.NearestAnchor != nil {
		t.Errorf("unparseable cand should have no anchor; got %+v", cands[0].Item.NearestAnchor)
	}
	if cands[1].Item.NearestAnchor == nil {
		t.Error("parseable cand should still get an anchor")
	}
}

func TestAttachNearestAnchor_NoAnchors(t *testing.T) {
	// No anchors → no panic, no mutation. Edge case for cold-start users.
	cands := []*db.RailCandidate{
		makeCand(1, []float32{1, 0, 0}),
	}
	attachNearestAnchor(cands, nil)
	if cands[0].Item.NearestAnchor != nil {
		t.Errorf("empty anchors should leave NearestAnchor nil; got %+v", cands[0].Item.NearestAnchor)
	}
}

// --------------------------------------------------------------------------
// parseDiscoverResponse — variant tolerance
// --------------------------------------------------------------------------

func TestParseDiscoverResponse_Conformant(t *testing.T) {
	raw := `{"rails":[{"title":"Cult Classics","picks":[{"index":1,"reason":"good"}]}]}`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 1 || rails[0].Title != "Cult Classics" || len(rails[0].Picks) != 1 || rails[0].Picks[0].Index != 1 {
		t.Errorf("unexpected parse: %+v", rails)
	}
}

func TestParseDiscoverResponse_NameAliasForTitle(t *testing.T) {
	// LLM uses "name" instead of "title" — fallback should pick it up.
	raw := `{"rails":[{"name":"Witty Horror","picks":[{"index":2,"reason":"x"}]}]}`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 1 || rails[0].Title != "Witty Horror" {
		t.Errorf("name alias failed: %+v", rails)
	}
}

func TestParseDiscoverResponse_ItemsAliasForPicks(t *testing.T) {
	raw := `{"rails":[{"title":"R","items":[{"index":3,"reason":"y"}]}]}`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 1 || len(rails[0].Picks) != 1 || rails[0].Picks[0].Index != 3 {
		t.Errorf("items alias failed: %+v", rails)
	}
}

func TestParseDiscoverResponse_BareArray(t *testing.T) {
	raw := `[{"title":"R","picks":[{"index":1,"reason":"a"}]}]`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 1 {
		t.Errorf("bare-array shape failed: %+v", rails)
	}
}

func TestParseDiscoverResponse_TitleOnlyPick(t *testing.T) {
	// Pick has title but no index — resolvePick handles this downstream.
	// Parser should retain it.
	raw := `{"rails":[{"title":"R","picks":[{"title":"Buffy","reason":"vampire stuff"}]}]}`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 1 || len(rails[0].Picks) != 1 || rails[0].Picks[0].Title != "Buffy" {
		t.Errorf("title-only pick dropped: %+v", rails)
	}
}

func TestParseDiscoverResponse_EmptyRailDropped(t *testing.T) {
	// Rail with no resolvable picks → dropped entirely.
	raw := `{"rails":[{"title":"R","picks":[{"foo":"bar"}]},{"title":"R2","picks":[{"index":1,"reason":"good"}]}]}`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 1 || rails[0].Title != "R2" {
		t.Errorf("empty rail should be dropped: %+v", rails)
	}
}

// TestParseDiscoverResponse_GemmaFlatTitleMap exercises gemma3:12b's
// hypothetical "compressed" discover shape: a flat object where each key
// is a rail title and each value is the picks array. Defensive fallback
// shipped May 14 after a bug-bash flagged the missing tolerance.
func TestParseDiscoverResponse_GemmaFlatTitleMap(t *testing.T) {
	raw := `{
		"Cult Classics": [{"index":1,"reason":"a"},{"index":2,"reason":"b"}],
		"Slow Burns": [{"index":3,"reason":"c"}]
	}`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 2 {
		t.Fatalf("want 2 rails, got %d: %+v", len(rails), rails)
	}
	// Map iteration order isn't deterministic — index by title.
	byTitle := make(map[string][]discoverPickSpec, 2)
	for _, r := range rails {
		byTitle[r.Title] = r.Picks
	}
	if got := byTitle["Cult Classics"]; len(got) != 2 || got[0].Index != 1 {
		t.Errorf("Cult Classics picks wrong: %+v", got)
	}
	if got := byTitle["Slow Burns"]; len(got) != 1 || got[0].Index != 3 {
		t.Errorf("Slow Burns picks wrong: %+v", got)
	}
}

// TestParseDiscoverResponse_GemmaFlatTitleMapFenced — same shape inside
// markdown fences. gemma fences nearly everything despite "no preamble".
func TestParseDiscoverResponse_GemmaFlatTitleMapFenced(t *testing.T) {
	raw := "```json\n{\"Horror\":[{\"index\":1,\"reason\":\"r\"}]}\n```"
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 1 || rails[0].Title != "Horror" {
		t.Errorf("fenced flat-map failed: %+v", rails)
	}
}

// TestParseDiscoverResponse_FlatMapNonArrayValueRejected guards against
// a false-positive flat-map match. If even one value isn't an array
// (e.g. a stray metadata field gemma threw in), we MUST bubble the
// standard parser's error rather than synthesizing wrong rails.
func TestParseDiscoverResponse_FlatMapNonArrayValueRejected(t *testing.T) {
	// "metadata" is a string — disqualifies the whole response as a
	// flat-title-map shape. parseDiscoverResponse returns the original
	// ExtractArray error.
	raw := `{"Horror":[{"index":1,"reason":"r"}],"metadata":"junk"}`
	_, err := parseDiscoverResponse(raw)
	if err == nil {
		t.Fatal("mixed-value flat map should error, got nil")
	}
}

// TestParseDiscoverResponse_FlatMapEmptyPicksFiltersRail: a flat-map
// entry whose array is empty (or all junk) should be dropped — same
// semantics as the standard parser's empty-rail filter. The remaining
// rails are returned successfully.
func TestParseDiscoverResponse_FlatMapEmptyPicksFiltersRail(t *testing.T) {
	raw := `{
		"Empty Rail": [],
		"Real Rail": [{"index":1,"reason":"r"}]
	}`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 1 || rails[0].Title != "Real Rail" {
		t.Errorf("expected only Real Rail: %+v", rails)
	}
}

// TestParseDiscoverResponse_UppercaseFieldKeys locks in the case-
// insensitive normalization for gemma3:12b's habit of uppercasing
// field names when values are user-facing labels. Production log
// May 14 showed the bare-array-with-uppercase-keys shape:
// [{"TITLE":"Monster Mash Mystery","PICKS":[...]},...]
// LowercaseKeys normalization absorbs this without per-field
// case-tolerance code.
func TestParseDiscoverResponse_UppercaseFieldKeys(t *testing.T) {
	raw := `[
		{"TITLE":"Monster Mash Mystery","PICKS":[{"index":1,"reason":"r1"},{"index":2,"reason":"r2"}]},
		{"TITLE":"Sci-Fi Adventures","PICKS":[{"index":5,"reason":"r5"}]}
	]`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 2 {
		t.Fatalf("want 2 rails, got %d: %+v", len(rails), rails)
	}
	if rails[0].Title != "Monster Mash Mystery" || len(rails[0].Picks) != 2 {
		t.Errorf("rail 0 wrong: %+v", rails[0])
	}
	if rails[1].Title != "Sci-Fi Adventures" || len(rails[1].Picks) != 1 {
		t.Errorf("rail 1 wrong: %+v", rails[1])
	}
}

// TestParseDiscoverResponse_MixedCaseKeys verifies tolerance for the
// more chaotic case where gemma mixes casings — e.g. "Title" for the
// rail and "INDEX" for the pick. Single normalization pass at each
// level handles arbitrary casing.
func TestParseDiscoverResponse_MixedCaseKeys(t *testing.T) {
	raw := `{"rails":[{"Title":"Quirky Fun","picks":[{"INDEX":3,"Reason":"r"}]}]}`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 1 || rails[0].Title != "Quirky Fun" {
		t.Fatalf("rail title wrong: %+v", rails)
	}
	if len(rails[0].Picks) != 1 || rails[0].Picks[0].Index != 3 || rails[0].Picks[0].Reason != "r" {
		t.Errorf("pick wrong: %+v", rails[0].Picks)
	}
}

// --------------------------------------------------------------------------
// parseRailReasonResponse — variant tolerance
// --------------------------------------------------------------------------

func TestParseRailReasonResponse_Conformant(t *testing.T) {
	raw := `{"reasons":[{"index":1,"reason":"a"},{"index":2,"reason":"b"}]}`
	got, err := parseRailReasonResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(got) != 2 || got[0].Reason != "a" || got[1].Index != 2 {
		t.Errorf("unexpected: %+v", got)
	}
}

func TestParseRailReasonResponse_IDInsteadOfIndex(t *testing.T) {
	raw := `{"reasons":[{"id":5,"reason":"c"}]}`
	got, err := parseRailReasonResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(got) != 1 || got[0].Index != 5 {
		t.Errorf("id-alias failed: %+v", got)
	}
}

func TestParseRailReasonResponse_AliasWrapper(t *testing.T) {
	raw := `{"picks":[{"index":7,"reason":"d"}]}`
	got, err := parseRailReasonResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(got) != 1 || got[0].Index != 7 {
		t.Errorf("alias wrapper failed: %+v", got)
	}
}

func TestParseRailReasonResponse_DropsEmptyReason(t *testing.T) {
	// A pick with empty reason is useless — skipped silently.
	raw := `{"reasons":[{"index":1,"reason":""},{"index":2,"reason":"good"}]}`
	got, err := parseRailReasonResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(got) != 1 || got[0].Index != 2 {
		t.Errorf("empty reason should be dropped: %+v", got)
	}
}

func TestParseRailReasonResponse_DropsMissingIndex(t *testing.T) {
	// No index AND no id → no way to map back to an item, drop.
	raw := `{"reasons":[{"reason":"orphan"}]}`
	got, err := parseRailReasonResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("missing-index should be dropped: %+v", got)
	}
}

func TestParseRailReasonResponse_MarkdownFenced(t *testing.T) {
	raw := "```json\n{\"reasons\":[{\"index\":1,\"reason\":\"fenced\"}]}\n```"
	got, err := parseRailReasonResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(got) != 1 || got[0].Reason != "fenced" {
		t.Errorf("fenced JSON failed: %+v", got)
	}
}

// TestParseRailReasonResponse_GemmaFlatMap exercises gemma3:12b's "compressed"
// schema output: instead of [{"index": N, "reason": "..."}], gemma collapses
// to {"N": "reason"} where the key IS the 1-based index. Production-observed
// shape (May 2026). Must parse without losing any picks.
func TestParseRailReasonResponse_GemmaFlatMap(t *testing.T) {
	raw := `{"1": "Slow-burn sci-fi like Severance", "2": "Witty horror-comedy", "3": "Cult classic"}`
	got, err := parseRailReasonResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("want 3 specs, got %d: %+v", len(got), got)
	}
	// Order is not guaranteed (map iteration), so build a lookup.
	byIdx := make(map[int]string, len(got))
	for _, s := range got {
		byIdx[s.Index] = s.Reason
	}
	if byIdx[1] != "Slow-burn sci-fi like Severance" ||
		byIdx[2] != "Witty horror-comedy" ||
		byIdx[3] != "Cult classic" {
		t.Errorf("flat-map reasons not captured correctly: %+v", byIdx)
	}
}

// TestParseRailReasonResponse_GemmaFlatMapFenced tests the realistic shape:
// gemma typically wraps the flat-map response in markdown fences too.
func TestParseRailReasonResponse_GemmaFlatMapFenced(t *testing.T) {
	raw := "```json\n{\"1\": \"reason one\", \"2\": \"reason two\"}\n```"
	got, err := parseRailReasonResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("fenced flat-map: want 2 specs, got %d: %+v", len(got), got)
	}
}

// TestParseRailReasonResponse_MixedKeysRejectsFlatMap guards against a
// false-positive flat-map match. If the response has BOTH numeric keys and
// named keys (a partial / corrupted shape), we must NOT silently interpret
// it as a flat-map — the standard-path error should propagate instead so
// the operator sees the actual shape problem.
func TestParseRailReasonResponse_MixedKeysRejectsFlatMap(t *testing.T) {
	raw := `{"1": "looks like an index", "stray": "but this isn't numeric"}`
	_, err := parseRailReasonResponse(raw)
	if err == nil {
		t.Fatal("mixed-key shape should return an error, got nil")
	}
}

// TestParseRailReasonResponse_FlatMapNonStringValueRejected guards against
// a half-shaped response like {"1": {"reason": "..."}}. Values must be
// strings to qualify as the flat-map shape — otherwise we don't recognize
// it and bubble the original error.
func TestParseRailReasonResponse_FlatMapNonStringValueRejected(t *testing.T) {
	raw := `{"1": {"reason": "nested"}, "2": {"reason": "also nested"}}`
	_, err := parseRailReasonResponse(raw)
	if err == nil {
		t.Fatal("nested-value shape should return an error, got nil")
	}
}

// --------------------------------------------------------------------------
// Invalidate completeness
// --------------------------------------------------------------------------

// TestInvalidate_ClearsAllPerProfileState locks in that Invalidate
// touches every per-profile cache and marker. If a future refactor adds
// a new per-profile cache field but forgets to wire Invalidate to clear
// it, this test FAILS — better than a stale-data bug in production.
// Bug-bash May 14 surfaced the reasonInflight gap; this test prevents
// regression.
func TestInvalidate_ClearsAllPerProfileState(t *testing.T) {
	h := &Hero{}
	const pid = int64(42)

	// Pre-populate every cache + marker the recommender owns.
	h.cache.Store(pid, cacheEntry{picks: []HeroPick{{Item: &models.MediaItem{ID: 1}}}})
	h.discoverCache.Store(pid, discoverCacheEntry{rails: []DiscoverRail{{Title: "x"}}})
	h.reasonCache.Store(railReasonKey{profileID: pid, itemID: 100}, railReasonEntry{reason: "r"})
	h.reasonInflight.Store(pid, struct{}{})

	// Also populate a DIFFERENT profile's state so we verify Invalidate
	// only touches the targeted profile.
	const other = int64(99)
	h.cache.Store(other, cacheEntry{picks: []HeroPick{{Item: &models.MediaItem{ID: 2}}}})
	h.discoverCache.Store(other, discoverCacheEntry{rails: []DiscoverRail{{Title: "other"}}})
	h.reasonCache.Store(railReasonKey{profileID: other, itemID: 200}, railReasonEntry{reason: "o"})
	h.reasonInflight.Store(other, struct{}{})

	h.Invalidate(pid)

	// Target profile state should be gone.
	if _, ok := h.cache.Load(pid); ok {
		t.Error("Invalidate did not clear cache for target profile")
	}
	if _, ok := h.discoverCache.Load(pid); ok {
		t.Error("Invalidate did not clear discoverCache for target profile")
	}
	if _, ok := h.reasonCache.Load(railReasonKey{profileID: pid, itemID: 100}); ok {
		t.Error("Invalidate did not clear reasonCache entry for target profile")
	}
	if _, ok := h.reasonInflight.Load(pid); ok {
		t.Error("Invalidate did not clear reasonInflight for target profile")
	}

	// Other profile state should remain intact.
	if _, ok := h.cache.Load(other); !ok {
		t.Error("Invalidate over-cleared cache for non-target profile")
	}
	if _, ok := h.discoverCache.Load(other); !ok {
		t.Error("Invalidate over-cleared discoverCache for non-target profile")
	}
	if _, ok := h.reasonCache.Load(railReasonKey{profileID: other, itemID: 200}); !ok {
		t.Error("Invalidate over-cleared reasonCache entry for non-target profile")
	}
	if _, ok := h.reasonInflight.Load(other); !ok {
		t.Error("Invalidate over-cleared reasonInflight for non-target profile")
	}
}

// TestInvalidate_BumpsEpoch locks in that each Invalidate advances the
// per-profile epoch counter. The TOCTOU guard in PoolFor/DiscoverFor
// depends on this monotonic advance: a build that started at epoch N
// must see epoch > N if any Invalidate fired during its execution.
func TestInvalidate_BumpsEpoch(t *testing.T) {
	h := &Hero{}
	const pid = int64(7)

	before := h.epochFor(pid).Load()
	h.Invalidate(pid)
	after := h.epochFor(pid).Load()
	if after != before+1 {
		t.Errorf("epoch should advance by 1, got before=%d after=%d", before, after)
	}

	// Second Invalidate advances again.
	h.Invalidate(pid)
	if got := h.epochFor(pid).Load(); got != before+2 {
		t.Errorf("epoch should advance to before+2, got %d", got)
	}
}

// TestEpochFor_PerProfileIndependence locks in that two profiles get
// independent epoch counters. Without this, an Invalidate on profile A
// would block a fresh build for profile B from caching its result.
func TestEpochFor_PerProfileIndependence(t *testing.T) {
	h := &Hero{}

	pA := h.epochFor(1)
	pB := h.epochFor(2)
	if pA == pB {
		t.Fatal("different profiles must have different epoch counters")
	}
	pA.Add(5)
	if pB.Load() != 0 {
		t.Errorf("bumping profile 1's epoch should not affect profile 2: %d", pB.Load())
	}
}

// --------------------------------------------------------------------------
// chatJSONWithRetryOn5xx — discover's retry policy in isolation
// --------------------------------------------------------------------------

// TestChatJSONWithRetryOn5xx_SuccessFirstTry: no error → no retry, no
// onRetry call. The most common happy path; if this fails, the retry
// helper is doing too much work on the success case.
func TestChatJSONWithRetryOn5xx_SuccessFirstTry(t *testing.T) {
	calls := 0
	retryHookFired := false
	got, err := chatJSONWithRetryOn5xx(
		context.Background(),
		func(ctx context.Context) (string, error) {
			calls++
			return "ok", nil
		},
		func(err error) { retryHookFired = true },
	)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != "ok" || calls != 1 {
		t.Errorf("want got='ok' calls=1, got got=%q calls=%d", got, calls)
	}
	if retryHookFired {
		t.Error("onRetry should not fire on success")
	}
}

// TestChatJSONWithRetryOn5xx_5xxRetryThenSuccess: the headline case.
// First call fails with a 5xx, retry succeeds, return the second result.
// Production-observed when Ollama Cloud has a transient blip.
func TestChatJSONWithRetryOn5xx_5xxRetryThenSuccess(t *testing.T) {
	calls := 0
	retryHookFired := false
	// Make the sleep fast — use a context with a deadline so the helper
	// returns reasonably quickly even though our fake doesn't sleep.
	got, err := chatJSONWithRetryOn5xx(
		context.Background(),
		func(ctx context.Context) (string, error) {
			calls++
			if calls == 1 {
				return "", &llm.StatusError{Op: "chat", Status: 500, Body: "transient"}
			}
			return "rails", nil
		},
		func(err error) { retryHookFired = true },
	)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != "rails" {
		t.Errorf("want 'rails', got %q", got)
	}
	if calls != 2 {
		t.Errorf("want 2 calls, got %d", calls)
	}
	if !retryHookFired {
		t.Error("onRetry should fire when a retry actually happens")
	}
}

// TestChatJSONWithRetryOn5xx_5xxThen5xx: both attempts fail with 5xx.
// Return the SECOND error so callers see the freshest signal.
func TestChatJSONWithRetryOn5xx_5xxThen5xx(t *testing.T) {
	calls := 0
	got, err := chatJSONWithRetryOn5xx(
		context.Background(),
		func(ctx context.Context) (string, error) {
			calls++
			if calls == 1 {
				return "", &llm.StatusError{Op: "chat", Status: 500, Body: "first"}
			}
			return "", &llm.StatusError{Op: "chat", Status: 502, Body: "second"}
		},
		nil,
	)
	if err == nil {
		t.Fatal("want error after both attempts fail, got nil")
	}
	if !strings.Contains(err.Error(), "second") {
		t.Errorf("want second-attempt error, got: %v", err)
	}
	if got != "" {
		t.Errorf("want empty raw on failure, got %q", got)
	}
	if calls != 2 {
		t.Errorf("want 2 calls, got %d", calls)
	}
}

// TestChatJSONWithRetryOn5xx_NoRetryOn4xx: a 4xx is a client bug
// (malformed request, auth issue) that retry can't fix. Don't retry.
func TestChatJSONWithRetryOn5xx_NoRetryOn4xx(t *testing.T) {
	calls := 0
	retryHookFired := false
	_, err := chatJSONWithRetryOn5xx(
		context.Background(),
		func(ctx context.Context) (string, error) {
			calls++
			return "", &llm.StatusError{Op: "chat", Status: 400, Body: "bad request"}
		},
		func(err error) { retryHookFired = true },
	)
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if calls != 1 {
		t.Errorf("want exactly 1 call for 4xx, got %d", calls)
	}
	if retryHookFired {
		t.Error("onRetry should NOT fire for 4xx")
	}
}

// TestChatJSONWithRetryOn5xx_NoRetryOnNetworkError: a non-HTTP error
// (timeout, connection refused) isn't a 5xx and we don't retry. The
// caller's outer ctx will already have handled the timing concerns.
func TestChatJSONWithRetryOn5xx_NoRetryOnNetworkError(t *testing.T) {
	calls := 0
	_, err := chatJSONWithRetryOn5xx(
		context.Background(),
		func(ctx context.Context) (string, error) {
			calls++
			return "", errors.New("decode top-level: invalid character")
		},
		nil,
	)
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if calls != 1 {
		t.Errorf("want 1 call for non-5xx, got %d", calls)
	}
}

// TestChatJSONWithRetryOn5xx_ContextCancelDuringBackoff: ctx canceled
// during the 1-second backoff. The helper must return promptly with
// ctx.Err() rather than waiting out the full second.
func TestChatJSONWithRetryOn5xx_ContextCancelDuringBackoff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	// First call fails 5xx → helper enters backoff. We cancel ctx via
	// a goroutine while the backoff is sleeping, simulating the parent
	// request being abandoned.
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	_, err := chatJSONWithRetryOn5xx(
		ctx,
		func(c context.Context) (string, error) {
			calls++
			if calls == 1 {
				return "", &llm.StatusError{Op: "chat", Status: 500, Body: "x"}
			}
			return "should-not-reach", nil
		},
		nil,
	)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("want ctx.Err() after cancel, got nil")
	}
	// We expect to return well before the full 1-second backoff.
	if elapsed > 500*time.Millisecond {
		t.Errorf("backoff didn't honor ctx cancel — slept %v", elapsed)
	}
	if calls != 1 {
		t.Errorf("want exactly 1 call when canceled before retry, got %d", calls)
	}
}

// TestChatJSONWithRetryOn5xx_NilOnRetryHook: passing nil onRetry must
// not panic when a 5xx triggers a retry. Defensive nil-check.
func TestChatJSONWithRetryOn5xx_NilOnRetryHook(t *testing.T) {
	calls := 0
	got, err := chatJSONWithRetryOn5xx(
		context.Background(),
		func(ctx context.Context) (string, error) {
			calls++
			if calls == 1 {
				return "", &llm.StatusError{Op: "chat", Status: 500, Body: "x"}
			}
			return "ok", nil
		},
		nil, // no hook
	)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != "ok" || calls != 2 {
		t.Errorf("want got='ok' calls=2, got got=%q calls=%d", got, calls)
	}
}

// --------------------------------------------------------------------------
// matchDisplay — per-user similarity → personal "% for you"
// --------------------------------------------------------------------------

// TestMatchDisplay covers the taste-vector similarity → integer personal
// "match %" mapping that drives the hero ring for personalized picks. It
// standardizes a similarity against the profile's candidate distribution
// (mean/std) then applies a logistic, replacing the old fixed-anchor
// calibrateMatch.
func TestMatchDisplay(t *testing.T) {
	// Cold-start / no centroid → 0 (the frontend shows the global Aurora Score).
	if got := matchDisplay(0, 0.8, 0.05); got != 0 {
		t.Errorf("sim<=0 should be 0, got %d", got)
	}
	// Degenerate distribution (σ≈0): a strong similarity still reads high via
	// the direct-band fallback rather than a meaningless 50.
	if got := matchDisplay(0.9, 0.9, 0); got < 70 {
		t.Errorf("degenerate σ: a 0.9 sim should still read high, got %d", got)
	}
	// Standardized: the distribution mean reads ~50; above-mean reads higher.
	mean, std := 0.80, 0.05
	if got := matchDisplay(mean, mean, std); got < 45 || got > 55 {
		t.Errorf("at the mean, expected ~50, got %d", got)
	}
	if !(matchDisplay(mean+std, mean, std) > matchDisplay(mean, mean, std)) {
		t.Error("an above-mean similarity should read higher than the mean")
	}

	// Bounded [0,100] and monotonic in sim for a fixed distribution — a higher
	// similarity can never produce a lower match %.
	prev := -1
	for s := 0.0; s <= 1.0001; s += 0.01 {
		got := matchDisplay(s, mean, std)
		if got < 0 || got > 100 {
			t.Fatalf("out of range at sim=%.2f: %d", s, got)
		}
		if s > 0 && got < prev {
			t.Fatalf("non-monotonic at sim=%.2f: %d < previous %d", s, got, prev)
		}
		prev = got
	}
}

// --------------------------------------------------------------------------
// parseDiscoverResponse — description field (Home net-new #3)
// --------------------------------------------------------------------------

func TestParseDiscoverResponse_Description(t *testing.T) {
	raw := `{"rails":[{"title":"Cult Classics","description":"Beloved oddities worth a rewatch","picks":[{"index":1,"reason":"good"}]}]}`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 1 {
		t.Fatalf("want 1 rail, got %d: %+v", len(rails), rails)
	}
	if rails[0].Description != "Beloved oddities worth a rewatch" {
		t.Errorf("description not parsed: %q", rails[0].Description)
	}
}

// A rail without a description must still parse (the field is optional) and
// leave Description empty so the frontend can fall back to its generic
// subtitle.
func TestParseDiscoverResponse_DescriptionOptional(t *testing.T) {
	raw := `{"rails":[{"title":"R","picks":[{"index":1,"reason":"a"}]}]}`
	rails, err := parseDiscoverResponse(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(rails) != 1 || rails[0].Description != "" {
		t.Errorf("absent description should stay empty: %+v", rails)
	}
}

// Defensive synonym handling: a model that emits "subtitle" (or "desc")
// instead of "description" should still populate Description. Also exercises
// the uppercase-key path (LowercaseKeys runs before the lookup), and that the
// description is trimmed.
func TestParseDiscoverResponse_DescriptionSynonyms(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{
			"subtitle alias",
			`{"rails":[{"title":"R","subtitle":"  themed line  ","picks":[{"index":1,"reason":"a"}]}]}`,
			"themed line",
		},
		{
			"desc alias",
			`{"rails":[{"title":"R","desc":"short theme","picks":[{"index":1,"reason":"a"}]}]}`,
			"short theme",
		},
		{
			"uppercase DESCRIPTION key",
			`{"rails":[{"TITLE":"R","DESCRIPTION":"caps theme","PICKS":[{"INDEX":1,"REASON":"a"}]}]}`,
			"caps theme",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rails, err := parseDiscoverResponse(tc.raw)
			if err != nil {
				t.Fatalf("parse failed: %v", err)
			}
			if len(rails) != 1 || rails[0].Description != tc.want {
				t.Errorf("want description %q, got %+v", tc.want, rails)
			}
		})
	}
}
