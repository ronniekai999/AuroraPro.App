package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Probe support for the admin "Test connection" endpoint: reachability plus
// which configured models an Ollama endpoint actually serves, so the operator
// sees "model X missing — run `ollama pull X`" instead of debugging silent
// keyword-search fallbacks. Kept in this package so probes ride the same
// SSRF-guarded transport and bearer rules as real traffic.

// tagsResponse mirrors GET /api/tags (the same endpoint Ping hits, but here
// we keep the payload instead of just the status code).
type tagsResponse struct {
	Models []struct {
		Name string `json:"name"`
	} `json:"models"`
}

// ListModels returns the model tags visible at baseURL. sendAuth mirrors the
// chat-call bearer rule: pass true only when baseURL is the endpoint the
// configured API key belongs to, so a probe never leaks the Cloud key to a
// local box.
func (c *Client) ListModels(ctx context.Context, baseURL string, sendAuth bool) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/api/tags", nil)
	if err != nil {
		return nil, err
	}
	if c.cfg.APIKey != "" && sendAuth {
		req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ollama tags: %w", err)
	}
	defer resp.Body.Close()
	raw, capErr := readCappedBody(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, &StatusError{Op: "tags", Status: resp.StatusCode, Body: snippet(raw, 512)}
	}
	if capErr != nil {
		return nil, fmt.Errorf("ollama tags: %w", capErr)
	}
	var out tagsResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("ollama tags: decode: %w", err)
	}
	names := make([]string, 0, len(out.Models))
	for _, m := range out.Models {
		if m.Name != "" {
			names = append(names, m.Name)
		}
	}
	return names, nil
}

// HasModelTag reports whether want is satisfied by the tag list. Ollama
// normalizes an untagged pull to ":latest" (`ollama pull embeddinggemma`
// lists as "embeddinggemma:latest"), so an untagged want matches either the
// bare name or its ":latest" form; a tagged want must match exactly.
func HasModelTag(tags []string, want string) bool {
	want = strings.TrimSpace(want)
	if want == "" {
		return false
	}
	for _, t := range tags {
		if t == want {
			return true
		}
		if !strings.Contains(want, ":") && t == want+":latest" {
			return true
		}
	}
	return false
}

// BaseURL exposes the effective chat endpoint for the admin test handler.
func (c *Client) BaseURL() string { return c.cfg.BaseURL }

// EmbedBaseURL exposes the effective embeddings endpoint (EmbedURL override
// when set, else BaseURL) for the admin test handler. It embodies boot's
// full resolution — including the Cloud→local embed coercion — which is why
// the handler prefers it over re-deriving the fallback.
func (c *Client) EmbedBaseURL() string { return c.embedURL() }
