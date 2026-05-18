package llmjson

import (
	"testing"
)

// TestLowercaseKeys_BasicLowercases the obvious case: uppercase keys
// become lowercase, values are preserved unchanged.
func TestLowercaseKeys_Basic(t *testing.T) {
	in := map[string]any{
		"TITLE": "Monster Mash",
		"PICKS": []any{1, 2, 3},
	}
	out := LowercaseKeys(in)
	if got, ok := out["title"]; !ok || got != "Monster Mash" {
		t.Errorf("expected title=Monster Mash, got %v ok=%v", got, ok)
	}
	if got, ok := out["picks"]; !ok || len(got.([]any)) != 3 {
		t.Errorf("expected picks=[1,2,3], got %v ok=%v", got, ok)
	}
}

// TestLowercaseKeys_MixedCase: gemma can mix casings within one
// object (e.g. "Title" + "PICKS"). Normalization handles them all.
func TestLowercaseKeys_MixedCase(t *testing.T) {
	in := map[string]any{
		"Title": "x",
		"PICKS": []any{},
		"index": 5,
	}
	out := LowercaseKeys(in)
	for _, want := range []string{"title", "picks", "index"} {
		if _, ok := out[want]; !ok {
			t.Errorf("missing key %q in output: %v", want, out)
		}
	}
}

// TestLowercaseKeys_AlreadyLower: a fully-lowercase input survives
// unchanged (identity-equivalent semantics, even though it's a copy).
func TestLowercaseKeys_AlreadyLower(t *testing.T) {
	in := map[string]any{"title": "x", "picks": "y"}
	out := LowercaseKeys(in)
	if len(out) != 2 || out["title"] != "x" || out["picks"] != "y" {
		t.Errorf("identity case broken: %v", out)
	}
}

// TestLowercaseKeys_OriginalUntouched: confirms the helper allocates
// a new map and doesn't mutate the input. Important because the input
// might be a shared decode buffer.
func TestLowercaseKeys_OriginalUntouched(t *testing.T) {
	in := map[string]any{"TITLE": "x"}
	_ = LowercaseKeys(in)
	if _, ok := in["TITLE"]; !ok {
		t.Error("original input was mutated")
	}
	if _, ok := in["title"]; ok {
		t.Error("original input got a new key inserted")
	}
}

// TestLowercaseKeys_EmptyInput: edge case — empty map produces empty
// map, no panic.
func TestLowercaseKeys_EmptyInput(t *testing.T) {
	out := LowercaseKeys(map[string]any{})
	if len(out) != 0 {
		t.Errorf("empty input should produce empty output, got %v", out)
	}
}

// TestLowercaseKeys_DuplicateCollisionLastWriteWins: documents the
// known semantic — if input has both "Title" and "TITLE", one
// overwrites the other (map iteration order is non-deterministic).
// In practice models don't emit both forms.
func TestLowercaseKeys_DuplicateCollisionLastWriteWins(t *testing.T) {
	in := map[string]any{"Title": "a", "TITLE": "b", "title": "c"}
	out := LowercaseKeys(in)
	if len(out) != 1 {
		t.Errorf("expected 1 key after collision, got %d: %v", len(out), out)
	}
	// We don't assert which value wins — iteration order is random.
	// We just confirm one of the three is present.
	v := out["title"]
	if v != "a" && v != "b" && v != "c" {
		t.Errorf("title value should be one of a/b/c, got %v", v)
	}
}
