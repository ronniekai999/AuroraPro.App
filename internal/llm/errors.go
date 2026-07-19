package llm

import "fmt"

// StatusError is returned whenever the LLM backend answers with a non-2xx
// HTTP status. Callers that branch on the status class — e.g. the discover
// surface retries once on 5xx — should use errors.As on this type instead of
// string-matching the message (the old "ollama chat: status 5" substring
// check, which silently stopped firing if the message format drifted).
//
// Error() deliberately renders the exact legacy shape
// ("ollama <op>: status <n>: <body>") so log grep patterns and the
// chat_routing_test contract keep working.
type StatusError struct {
	Op     string // "chat" or "embed"
	Status int    // HTTP status code from the backend
	Body   string // capped response snippet for diagnostics
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("ollama %s: status %d: %s", e.Op, e.Status, e.Body)
}

// IsServerError reports whether the backend answered with a 5xx — the class
// worth retrying (4xx is a caller bug auth/shape-wise; retrying it just
// repeats the mistake).
func (e *StatusError) IsServerError() bool { return e.Status >= 500 }
