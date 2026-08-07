package llm

// Structured-output schema adaptation for the hosted providers. Aurora's
// surface schemas (hero, rerank listwise, discover) are written loosely —
// Ollama treats them as guidance — but Anthropic's output_config.format and
// OpenAI's json_schema dialects are strict validators: they REJECT requests
// carrying unsupported keywords (minLength, minimum, pattern, format, ...)
// instead of ignoring them, and they require additionalProperties:false on
// object nodes. sanitizeStructuredSchema adapts on the way out so the
// package-level schema vars stay provider-neutral.

// schemaKeywordAllowlist is the set of keywords forwarded to hosted
// providers. Allowlist rather than denylist so a future schema addition
// fails safe (the keyword is dropped, loosening validation — the tolerant
// llmjson parser downstream absorbs that) instead of 400ing every call.
// Combinators (anyOf/allOf/$ref) are deliberately absent: no Aurora schema
// uses them, and forwarding them un-audited risks provider-specific rules
// (e.g. recursion bans) surfacing as runtime 400s.
var schemaKeywordAllowlist = map[string]bool{
	"type":                 true,
	"properties":           true,
	"required":             true,
	"items":                true,
	"enum":                 true,
	"const":                true,
	"description":          true,
	"additionalProperties": true,
}

// sanitizeStructuredSchema returns a deep copy of schema fit for the hosted
// providers' strict structured-output dialects: only allowlisted keywords
// survive, and every object node carries additionalProperties:false (an
// existing additionalProperties value is overwritten — strict modes accept
// only false). The input is never mutated: callers pass shared package-level
// schema vars. Non-map inputs (nil included) pass through unchanged.
func sanitizeStructuredSchema(schema any) any {
	node, ok := schema.(map[string]any)
	if !ok {
		return schema
	}
	out := make(map[string]any, len(node)+1)
	for k, v := range node {
		if !schemaKeywordAllowlist[k] {
			continue
		}
		switch k {
		case "properties":
			props, ok := v.(map[string]any)
			if !ok {
				continue // malformed; dropping loosens validation, never breaks the call
			}
			cleaned := make(map[string]any, len(props))
			for name, sub := range props {
				cleaned[name] = sanitizeStructuredSchema(sub)
			}
			out[k] = cleaned
		case "items":
			// items is a schema (or, rarely, a list of schemas).
			if list, ok := v.([]any); ok {
				cleanedList := make([]any, len(list))
				for i, sub := range list {
					cleanedList[i] = sanitizeStructuredSchema(sub)
				}
				out[k] = cleanedList
				continue
			}
			out[k] = sanitizeStructuredSchema(v)
		case "additionalProperties":
			// Re-injected below; whatever the source said, strict modes only
			// accept false.
			continue
		default:
			out[k] = deepCopyJSONValue(v)
		}
	}
	if isObjectSchema(node) {
		out["additionalProperties"] = false
	}
	return out
}

// isObjectSchema reports whether node describes a JSON object — explicitly
// typed as one, or implicitly via a properties map.
func isObjectSchema(node map[string]any) bool {
	if t, ok := node["type"].(string); ok && t == "object" {
		return true
	}
	_, hasProps := node["properties"]
	return hasProps
}

// deepCopyJSONValue copies JSON-shaped values (maps/slices recursively,
// scalars as-is) so sanitized output never aliases the caller's schema.
func deepCopyJSONValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, sub := range t {
			out[k] = deepCopyJSONValue(sub)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, sub := range t {
			out[i] = deepCopyJSONValue(sub)
		}
		return out
	default:
		return v
	}
}
