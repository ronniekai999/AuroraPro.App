// Package llmjson holds the shape-tolerant decoding helpers shared by every
// LLM-consuming subsystem (search rerank, hero rerank, future tools).
//
// Hosted chat models — gemma3:12b and gpt-oss:20b in particular — frequently
// ignore JSON Schema constraints and emit one of several near-correct shapes:
//
//   - bare top-level array instead of {"picks":[...]}
//   - alternate wrapper keys: "selected", "results", "featured", ...
//   - "id" instead of "index" on individual picks
//   - markdown-fenced JSON despite "no preamble" instructions
//
// Every parser around the codebase was reimplementing the same fallback chain;
// consolidating here removes drift risk and makes adding new aliases a one-
// line change.
package llmjson

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
)

// StripFences removes ```json ... ``` (or bare ```) wrappers that some models
// add despite being told "no preamble". Idempotent — passing already-clean
// JSON is a no-op.
func StripFences(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "```"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// PickInt extracts an integer-valued field from a decoded JSON object.
//
// Returns (value, ok). `ok=false` means the key is absent OR the value is
// unparseable. Callers that conflate "absent" with "value is 0" are buggy if
// a model ever emits 0-based indices; using the (value, bool) form forces an
// explicit presence check at the call site.
//
// JSON numbers come back as float64 from encoding/json's interface{} decoder,
// so we have to handle that and a few other shapes hosted models emit.
// NaN and Inf are rejected (return ok=false) because int(NaN) is platform-
// dependent garbage.
func PickInt(obj map[string]any, key string) (int, bool) {
	v, ok := obj[key]
	if !ok {
		return 0, false
	}
	switch t := v.(type) {
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return 0, false
		}
		return int(t), true
	case int:
		return t, true
	case json.Number:
		n, err := t.Int64()
		if err != nil {
			return 0, false
		}
		return int(n), true
	case string:
		var n int
		if _, err := fmt.Sscanf(t, "%d", &n); err != nil {
			return 0, false
		}
		return n, true
	}
	return 0, false
}

// SortedKeys returns the keys of m, sorted for stable log output. Used only
// in error paths where we want to tell the operator "I looked in these keys".
func SortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// LowercaseKeys returns a copy of obj with all top-level keys lowercased.
// Use this when a parser needs case-insensitive lookups against an LLM
// response — gemma3:12b sometimes uppercases field keys when the values
// are user-facing labels (e.g. {"TITLE": "Cult Classics", "PICKS": [...]}
// observed in production discover responses May 14, 2026). Lowercasing
// once and then doing lowercase lookups is cheaper than rewriting every
// `obj["title"]` site as a case-insensitive scan.
//
// One-level only — does NOT recurse into nested objects. Callers that
// need to normalize a nested pick object should call this again on each
// inner map. Allocates a new map; original is untouched.
//
// On duplicate keys after lowercase (e.g. obj has both "title" and
// "Title"), iteration order determines which wins — same last-write-wins
// semantic as raw map writes. In practice models don't emit both forms.
func LowercaseKeys(obj map[string]any) map[string]any {
	out := make(map[string]any, len(obj))
	for k, v := range obj {
		out[strings.ToLower(k)] = v
	}
	return out
}

// ExtractArray decodes a raw LLM response into an array of items, tolerating
// the three shapes we see in production:
//
//  1. Bare top-level array: `[{...}, {...}]`
//  2. Object wrapped under any of `aliases`: `{"picks":[...]}`, `{"selected":[...]}`, etc.
//  3. Markdown-fenced JSON: ` ```json\n{...}\n``` `
//
// Returns the array contents plus a nil error on any of those. On total
// failure returns an error that names every alias we tried, so logs are
// actionable.
//
// Callers iterate the returned []any and use PickInt + map[string]any to
// extract per-item fields — keeps this helper free of pick-shape opinions.
func ExtractArray(raw string, aliases []string) ([]any, error) {
	cleaned := StripFences(raw)

	var arr []any
	if err := json.Unmarshal([]byte(cleaned), &arr); err == nil {
		return arr, nil
	}

	var top map[string]any
	if err := json.Unmarshal([]byte(cleaned), &top); err != nil {
		return nil, fmt.Errorf("decode top-level: %w", err)
	}
	for _, key := range aliases {
		if v, ok := top[key]; ok {
			if a, ok := v.([]any); ok {
				return a, nil
			}
		}
	}
	return nil, fmt.Errorf("no array found under any of %v in top-level keys %v",
		aliases, SortedKeys(top))
}

// ExtractArrayLoose is ExtractArray plus a generic last-resort recovery: when no
// alias matches, it returns the LONGEST top-level value that is a non-empty array
// OF OBJECTS. Cloud models keep inventing new wrapper keys for the same payload
// (gpt-oss "selected"; deepseek-v4-flash has used "candidates" then "selections"
// across runs) — this stops the per-key whack-a-mole.
//
// Use this ONLY for callers whose payload is a single wrapped array (the hero
// rerank). Do NOT use it for callers that depend on a strict miss to trigger a
// different shape recovery — notably Discover, whose flat-title-map fallback
// (parseDiscoverFlatTitleMap) relies on ExtractArray FAILING on the
// {railTitle: picksArray} shape; the loose grab would mis-read a picks array as
// the rails array. Hence the deliberate split rather than folding this into
// ExtractArray.
//
// The array-of-objects guard avoids grabbing a stray string array; SortedKeys
// keeps the choice deterministic when several arrays are present.
func ExtractArrayLoose(raw string, aliases []string) ([]any, error) {
	if a, err := ExtractArray(raw, aliases); err == nil {
		return a, nil
	}
	var top map[string]any
	if err := json.Unmarshal([]byte(StripFences(raw)), &top); err != nil {
		return nil, fmt.Errorf("decode top-level: %w", err)
	}
	var best []any
	for _, key := range SortedKeys(top) {
		a, ok := top[key].([]any)
		if !ok || len(a) == 0 {
			continue
		}
		if _, isObj := a[0].(map[string]any); !isObj {
			continue
		}
		if len(a) > len(best) {
			best = a
		}
	}
	if best != nil {
		return best, nil
	}
	return nil, fmt.Errorf("no array found under any of %v (no array-of-objects fallback) in top-level keys %v",
		aliases, SortedKeys(top))
}
