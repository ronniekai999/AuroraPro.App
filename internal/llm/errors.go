package llm

import (
	"fmt"
	"net/http"
	"strings"
)

// StatusError is returned whenever the LLM backend answers with a non-2xx
// HTTP status. Callers that branch on the status class — e.g. the discover
// surface retries once on retryable statuses — should use errors.As on this
// type instead of string-matching the message (the old "ollama chat: status 5"
// substring check, which silently stopped firing if the message format
// drifted).
type StatusError struct {
	Op     string // "chat"/"embed"/"tags" (Ollama) or backend-qualified ("anthropic chat", "openai embed", ...)
	Status int    // HTTP status code from the backend
	Body   string // capped response snippet for diagnostics
}

func (e *StatusError) Error() string {
	if strings.Contains(e.Op, " ") {
		// Hosted-provider ops name their backend themselves ("anthropic
		// chat") — prefixing "ollama" would point an operator at the wrong
		// service entirely.
		return fmt.Sprintf("%s: status %d: %s", e.Op, e.Status, e.Body)
	}
	// Legacy single-word ops keep the exact historical "ollama <op>"
	// rendering that log grep patterns and the chat_routing_test contract pin.
	return fmt.Sprintf("ollama %s: status %d: %s", e.Op, e.Status, e.Body)
}

// IsServerError reports whether the backend answered with a 5xx — the class
// worth retrying (4xx is a caller bug auth/shape-wise; retrying it just
// repeats the mistake).
func (e *StatusError) IsServerError() bool { return e.Status >= 500 }

// IsRetryable reports whether a single polite retry is worthwhile: any 5xx
// (Ollama hiccups, Anthropic's 529 overloaded) plus 429 — the hosted
// providers' per-minute token buckets routinely clear inside the callers'
// 1s backoff, and unlike other 4xx a rate limit is not a request bug.
// Other 4xx (401 bad key, 400 bad shape) stay non-retryable.
func (e *StatusError) IsRetryable() bool {
	return e.Status >= 500 || e.Status == http.StatusTooManyRequests
}
