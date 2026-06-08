package api

import "testing"

// TestLLMSettingKeyReasoningEffort locks the DB key string so a rename can't
// silently desync the GetLLMSettings read from the UpdateLLMSettings write (the
// drift the centralized llmSettingKeys is meant to prevent) or from main.go's
// applyLLMOverrides, which reads the same literal.
func TestLLMSettingKeyReasoningEffort(t *testing.T) {
	if llmSettingKeys.ReasoningEffort != "llm_reasoning_effort" {
		t.Errorf("reasoning_effort key = %q, want llm_reasoning_effort", llmSettingKeys.ReasoningEffort)
	}
}

// TestValidReasoningEffort guards the allowlist UpdateLLMSettings enforces.
func TestValidReasoningEffort(t *testing.T) {
	for _, v := range []string{"", "low", "medium", "high", "none"} {
		if !validReasoningEffort(v) {
			t.Errorf("%q should be valid", v)
		}
	}
	for _, v := range []string{"minimal", "false", "lo", "LOW", "0", "default"} {
		if validReasoningEffort(v) {
			t.Errorf("%q should be invalid", v)
		}
	}
}
