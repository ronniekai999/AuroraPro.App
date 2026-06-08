package llmjson

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// trailingBracketTag matches a trailing "[content]" tag with optional
// surrounding whitespace. Content is restricted to non-space chars so
// we don't accidentally strip mid-title bracket content like
// "Show [Region 1] Edition" — only the prompt-shape `[type]` /
// `[show]` / `[movie]` suffix that LLMs mirror from the candidate list.
var trailingBracketTag = regexp.MustCompile(`\s*\[\S+\]\s*$`)

// foldAccents folds diacritics to their base letter (é → e) via NFD
// decomposition + dropping combining marks, so an accented candidate title
// still matches an LLM that emitted the unaccented form.
func foldAccents(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range norm.NFD.String(s) {
		if unicode.Is(unicode.Mn, r) {
			continue // combining mark
		}
		b.WriteRune(r)
	}
	return b.String()
}

// normalizeTitle produces a loose comparison key: accents folded, lowercased,
// "&" → "and", and every run of non-alphanumeric chars collapsed to one space
// (so superscripts, punctuation, and subtitle colons drop out). "The Accountant²"
// and "The Accountant" both normalize to "the accountant"; "Drake & Josh" →
// "drake and josh". Used ONLY for the collision-excluded loose-key tier in
// ResolveByTitle — never as a primary lookup, since a loose match is weaker than
// the exact / lowercase / year / tag forms.
func normalizeTitle(s string) string {
	s = strings.ToLower(foldAccents(s))
	s = strings.ReplaceAll(s, "&", " and ")
	var b strings.Builder
	b.Grow(len(s))
	space := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			space = false
		} else if !space {
			b.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(b.String())
}

// seedLooseKeys adds collision-excluded "loose" keys so ResolveByTitle can
// recover LLM title drift — dropped superscripts ("The Accountant²" →
// "The Accountant"), dropped subtitles ("The Conjuring: Last Rites" →
// "The Conjuring"), accents, and &/and. For each candidate it offers the
// normalized full title and the normalized pre-colon part. A loose key that
// maps to MORE THAN ONE candidate is ambiguous and dropped entirely (never
// resolves), so we never fuzzy-match into the wrong pick; a loose key that would
// shadow an existing exact/lowercase key for a DIFFERENT index is also skipped.
// Loose keys are NOT counted toward the collision total (they're seeded after
// the counted pass). Keys shorter than 3 chars are skipped as too weak.
func seedLooseKeys[T any](idx map[string]int, items []T, extract func(T) (title string, year int)) {
	cand := make(map[string]map[int]struct{})
	add := func(key string, i int) {
		if len(key) < 3 {
			return
		}
		if cand[key] == nil {
			cand[key] = make(map[int]struct{})
		}
		cand[key][i] = struct{}{}
	}
	for i, item := range items {
		title, _ := extract(item)
		if title == "" {
			continue
		}
		add(normalizeTitle(title), i)
		if before, _, found := strings.Cut(title, ":"); found {
			add(normalizeTitle(before), i)
		}
	}
	for key, idxs := range cand {
		if len(idxs) != 1 {
			continue // ambiguous loose key → never resolve
		}
		var only int
		for k := range idxs {
			only = k
		}
		if existing, ok := idx[key]; ok && existing != only {
			continue // would shadow an exact/lowercase key for a different item
		}
		idx[key] = only
	}
}

// Title-fallback resolution for LLM-emitted picks.
//
// Background: Cloud chat models (gemma3:12b especially) frequently emit
// picks with a `title` field but NO `index` — our parsers tolerantly
// capture the title, and the resolver then maps the title back to the
// candidate slice position. Three call sites in the recommender stack
// (hero rerank, discover, search rerank) previously each implemented
// this resolver inline with slightly different ergonomics:
//
//   - hero and search built `map[string]int` indexes; both seed bare
//     Title + lowercase + "Title (YEAR)" + lowercase "Title (YEAR)".
//   - discover used four linear scans over the candidate slice, which
//     is O(N×K) per request and diverged subtly from the map versions
//     in how the year-suffix lowercase comparison was computed.
//
// Bug bash (May 14, 2026) flagged the drift. This helper consolidates
// the seeding and lookup into a single implementation. Callers extract
// (title, year) per item via an accessor function (we can't import
// models from this package without a cycle).
//
// Precedence at lookup time is:
//   1. Exact match on the pick's title
//   2. Lowercase match
// Because the index pre-seeds both the bare title AND the "Title (YEAR)"
// form (both cases), this two-step lookup covers all four shapes gemma
// emits today. If a model ever emits "Title - YEAR" or "Title [YEAR]",
// add the form to BuildCandidateTitleIndex and every caller picks it up.

// CandidateTitleIndex is the lookup map produced by BuildCandidateTitleIndex
// and consumed by ResolveByTitle. Exposed as a named type so call sites can
// store it in struct fields or pass it around without typing
// `map[string]int` everywhere.
type CandidateTitleIndex = map[string]int

// BuildCandidateTitleIndex seeds a lookup map with both bare and
// year-suffixed forms of each candidate's title, in both their original
// and lowercase cases. The returned map answers "given an LLM-emitted
// title (which may or may not include a year suffix), which candidate
// index does it refer to?"
//
// Generic over the candidate type. The `extract` function returns
// (title, year) for each item — year ≤ 0 means "no year known", in which
// case only the bare/lowercase forms are seeded (no "Title (0)" entry).
//
// Capacity is pre-allocated assuming up to 4 entries per candidate.
//
// COLLISION SEMANTICS: Duplicate (title, year) tuples last-write-win.
// In practice this is rare — the SQL recall layer dedups via tmdb_id, so
// two items with the same TMDB identity collapse to one row before
// reaching here. Collisions can only occur when two un-enriched items
// (tmdb_id=0) happen to share both title and year. The CollisionCount
// return value lets callers observe and log this case if it matters —
// today nothing does, but if production ever surfaces wrong-pick
// reports for ambiguously-titled items, the count is the diagnostic
// signal. See L14 in the May 14 bug-bash.
//
// The collision is detected by comparing the index size against the
// expected entry count: each non-empty-title candidate contributes
// either 2 entries (year=0) or 4 entries (year>0), and any shortfall
// is a collision.
func BuildCandidateTitleIndex[T any](items []T, extract func(T) (title string, year int)) CandidateTitleIndex {
	idx, _ := BuildCandidateTitleIndexWithCollisions(items, extract)
	return idx
}

// BuildCandidateTitleIndexWithCollisions is the diagnostic variant of
// BuildCandidateTitleIndex. Returns both the lookup index AND the
// count of key collisions encountered during seeding (any later write
// that overwrote an earlier one). A collision count > 0 is benign in
// practice but indicates an ambiguous catalog — two items the resolver
// can't distinguish by title alone. Callers may log at Debug if they
// want observability.
func BuildCandidateTitleIndexWithCollisions[T any](items []T, extract func(T) (title string, year int)) (CandidateTitleIndex, int) {
	idx := make(CandidateTitleIndex, len(items)*4)
	collisions := 0
	put := func(key string, val int) {
		// Count only CROSS-ITEM collisions — when the same item seeds
		// the same key twice (e.g. an already-lowercase title produces
		// identical bare-and-lowercase forms), the value is unchanged
		// and that's a no-op write, not an ambiguity. Only an
		// existing-index DIFFERENT from the new one signals two
		// distinct candidates with the same display key.
		if existing, exists := idx[key]; exists && existing != val {
			collisions++
		}
		idx[key] = val
	}
	for i, item := range items {
		title, year := extract(item)
		if title == "" {
			continue
		}
		put(title, i)
		put(strings.ToLower(title), i)
		if year > 0 {
			withYear := title + " (" + strconv.Itoa(year) + ")"
			put(withYear, i)
			put(strings.ToLower(withYear), i)
		}
	}
	seedLooseKeys(idx, items, extract)
	return idx, collisions
}

// ResolveByTitle answers "given an LLM-emitted title, which candidate
// index does it map to?" using the lookup produced by
// BuildCandidateTitleIndex. Tries exact-case first, then case-insensitive.
//
// Returns (index, true) on hit, (0, false) on miss. Callers should treat
// miss as "skip this pick" rather than defaulting to 0 — a wrong fuzzy
// match silently corrupts the result list.
//
// Empty pickTitle returns false (defensive: an LLM that emits picks with
// neither index NOR title is unrecoverable; we shouldn't pretend to
// resolve to position 0).
func ResolveByTitle(idx CandidateTitleIndex, pickTitle string) (int, bool) {
	pickTitle = strings.TrimSpace(pickTitle)
	if pickTitle == "" {
		return 0, false
	}
	if i, ok := idx[pickTitle]; ok {
		return i, true
	}
	if i, ok := idx[strings.ToLower(pickTitle)]; ok {
		return i, true
	}
	// LLMs sometimes mirror the candidate-list prompt format back into
	// their picks, e.g. `"title": "Lizzie McGuire (2001) [show]"`. The
	// candidate prompt is built by buildRerankPrompt / buildDiscoverPrompt
	// in the recommender as `"Title (YEAR) [type]"`, but the index only
	// seeds `Title` and `Title (YEAR)` variants — so the tagged title
	// falls through and the pick gets dropped. gpt-oss:120b observed
	// emitting this format consistently (2026-05-21). Strip the trailing
	// `[\S+]` tag and retry the lookup.
	//
	// The regex restricts to non-whitespace content inside the brackets
	// so we don't accidentally consume mid-title bracket sequences like
	// "Show [Region 1] Edition" — only the prompt-shape tag at end of
	// string (`[show]`, `[movie]`, future single-token tags). On a real
	// match the resolver retries both case variants of the cleaned form.
	if cleaned := trailingBracketTag.ReplaceAllString(pickTitle, ""); cleaned != pickTitle {
		cleaned = strings.TrimSpace(cleaned)
		if cleaned == "" {
			return 0, false
		}
		if i, ok := idx[cleaned]; ok {
			return i, true
		}
		if i, ok := idx[strings.ToLower(cleaned)]; ok {
			return i, true
		}
	}

	// Loose tier (last resort): an accent/superscript/subtitle/&-tolerant
	// normalized key. Only collision-excluded keys were seeded (seedLooseKeys),
	// so a hit here is unambiguous — and exact/lowercase/year/tag forms always
	// win first. Recovers drift like "The Accountant" → "The Accountant²" and
	// "The Conjuring" → "The Conjuring: Last Rites".
	if n := normalizeTitle(pickTitle); len(n) >= 3 {
		if i, ok := idx[n]; ok {
			return i, true
		}
	}
	return 0, false
}
