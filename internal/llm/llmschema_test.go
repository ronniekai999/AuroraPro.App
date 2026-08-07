package llm

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestSanitizeStructuredSchemaInjectsAdditionalProperties(t *testing.T) {
	in := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"rails": map[string]any{
				"type": "array",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"title": map[string]any{"type": "string"},
					},
					"required": []any{"title"},
				},
			},
		},
		"required": []any{"rails"},
	}
	out, ok := sanitizeStructuredSchema(in).(map[string]any)
	if !ok {
		t.Fatalf("want map output, got %T", sanitizeStructuredSchema(in))
	}
	if out["additionalProperties"] != false {
		t.Errorf("root object missing additionalProperties:false, got %v", out["additionalProperties"])
	}
	item := out["properties"].(map[string]any)["rails"].(map[string]any)["items"].(map[string]any)
	if item["additionalProperties"] != false {
		t.Errorf("nested object missing additionalProperties:false, got %v", item["additionalProperties"])
	}
	if !reflect.DeepEqual(item["required"], []any{"title"}) {
		t.Errorf("required not preserved: %v", item["required"])
	}
}

func TestSanitizeStructuredSchemaStripsUnsupportedKeywords(t *testing.T) {
	in := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"score": map[string]any{
				"type":    "number",
				"minimum": 0,
				"maximum": 1,
			},
			"reason": map[string]any{
				"type":      "string",
				"maxLength": 200,
				"pattern":   "^[a-z]+$",
				"format":    "uri",
			},
			"kind": map[string]any{
				"type": "string",
				"enum": []any{"movie", "show"},
			},
		},
		"minProperties": 1,
	}
	out := sanitizeStructuredSchema(in).(map[string]any)
	if _, has := out["minProperties"]; has {
		t.Error("minProperties should be stripped at the root")
	}
	props := out["properties"].(map[string]any)
	score := props["score"].(map[string]any)
	for _, bad := range []string{"minimum", "maximum"} {
		if _, has := score[bad]; has {
			t.Errorf("score.%s should be stripped", bad)
		}
	}
	reason := props["reason"].(map[string]any)
	for _, bad := range []string{"maxLength", "pattern", "format"} {
		if _, has := reason[bad]; has {
			t.Errorf("reason.%s should be stripped", bad)
		}
	}
	if !reflect.DeepEqual(props["kind"].(map[string]any)["enum"], []any{"movie", "show"}) {
		t.Errorf("enum not preserved: %v", props["kind"])
	}
}

func TestSanitizeStructuredSchemaOverridesAdditionalProperties(t *testing.T) {
	in := map[string]any{
		"type":                 "object",
		"properties":           map[string]any{"a": map[string]any{"type": "string"}},
		"additionalProperties": true, // strict modes accept only false
	}
	out := sanitizeStructuredSchema(in).(map[string]any)
	if out["additionalProperties"] != false {
		t.Errorf("additionalProperties must be forced to false, got %v", out["additionalProperties"])
	}
}

func TestSanitizeStructuredSchemaDoesNotMutateInput(t *testing.T) {
	in := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"n": map[string]any{"type": "number", "minimum": 0},
		},
	}
	before, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	_ = sanitizeStructuredSchema(in)
	after, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Errorf("input mutated:\nbefore %s\nafter  %s", before, after)
	}
}

func TestSanitizeStructuredSchemaPassthrough(t *testing.T) {
	if got := sanitizeStructuredSchema(nil); got != nil {
		t.Errorf("nil should pass through, got %v", got)
	}
	if got := sanitizeStructuredSchema("not a schema"); got != "not a schema" {
		t.Errorf("non-map should pass through, got %v", got)
	}
}

func TestSanitizeStructuredSchemaOnRealSurfaceSchema(t *testing.T) {
	// The package's own listwise rerank schema must survive sanitization with
	// its shape intact — this is the schema every hosted-provider rerank call
	// will carry.
	out := sanitizeStructuredSchema(rerankListwiseSchema).(map[string]any)
	if out["additionalProperties"] != false {
		t.Error("rerank schema root should carry additionalProperties:false")
	}
	if _, has := out["properties"]; !has {
		t.Error("rerank schema lost its properties")
	}
}

func TestClientProviderDefaults(t *testing.T) {
	anthropic := NewClient(Config{Provider: ProviderAnthropic})
	if got := anthropic.ChatModelFast(); got != anthropicDefaultChatModel {
		t.Errorf("anthropic fast default = %q, want %q", got, anthropicDefaultChatModel)
	}
	if got := anthropic.ChatModelSmart(); got != anthropicDefaultSmartModel {
		t.Errorf("anthropic smart default = %q, want %q", got, anthropicDefaultSmartModel)
	}

	openai := NewClient(Config{Provider: ProviderOpenAI, EmbedProvider: ProviderOpenAI})
	if got := openai.ChatModelFast(); got != openaiDefaultChatModel {
		t.Errorf("openai fast default = %q, want %q", got, openaiDefaultChatModel)
	}
	if got := openai.ChatModelSmart(); got != openaiDefaultSmartModel {
		t.Errorf("openai smart default = %q, want %q", got, openaiDefaultSmartModel)
	}
	if got := openai.EmbedModel(); got != openaiDefaultEmbedModel {
		t.Errorf("openai embed default = %q, want %q", got, openaiDefaultEmbedModel)
	}

	// A legacy/zero Config must keep the pre-provider defaults untouched.
	legacy := NewClient(Config{})
	if got := legacy.ChatModel(); got != "qwen3:4b-instruct" {
		t.Errorf("legacy chat default drifted: %q", got)
	}
	if got := legacy.EmbedModel(); got != "qwen3-embedding:0.6b" {
		t.Errorf("legacy embed default drifted: %q", got)
	}
}

func TestEmbedSpaceID(t *testing.T) {
	// Ollama-family spaces MUST stay the bare model name — that is the format
	// every existing install's marker row holds; qualifying it would null all
	// vectors on upgrade (see EmbedSpaceID doc).
	local := NewClient(Config{EmbedModel: "qwen3-embedding:0.6b"})
	if got := local.EmbedSpaceID(); got != "qwen3-embedding:0.6b" {
		t.Errorf("local space id = %q, want bare model name", got)
	}
	cloudChat := NewClient(Config{Provider: ProviderCloud, EmbedModel: "qwen3-embedding:0.6b"})
	if got := cloudChat.EmbedSpaceID(); got != "qwen3-embedding:0.6b" {
		t.Errorf("cloud-chat space id = %q, want bare model name (chat provider must not qualify the embed space)", got)
	}
	openai := NewClient(Config{EmbedProvider: ProviderOpenAI})
	if got := openai.EmbedSpaceID(); got != "openai/"+openaiDefaultEmbedModel {
		t.Errorf("openai space id = %q, want provider-qualified", got)
	}
}
