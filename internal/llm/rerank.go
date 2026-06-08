package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// rerankPairTimeout bounds a single (query, document) judge call. A local
	// 0.6B reranker answers in well under this; the cap stops one stalled pair
	// from holding a concurrency slot for the whole batch.
	rerankPairTimeout = 4 * time.Second

	// rerankConcurrency caps in-flight pair calls. Each is a tiny 1-token
	// generation; ~6 keeps a local reranker busy without starving the box that
	// also serves embeddings.
	rerankConcurrency = 6
)

// rerankJudgeSystem is the cross-encoder judge instruction. Qwen3-Reranker is
// trained to answer this kind of yes/no relevance question; we read the
// probability mass on the "yes" token as the relevance score.
const rerankJudgeSystem = `Judge whether the Document is relevant to the Query. ` +
	`The Query describes a viewer's taste in movies and TV; the Document describes one title. ` +
	`Answer with only one word: "yes" or "no".`

// RerankModelName returns the configured cross-encoder reranker model, or "" when
// reranking is disabled. Callers use it to skip the whole stage cheaply.
func (c *Client) RerankModelName() string { return c.cfg.RerankModel }

// rerankBaseURL returns where to reach the reranker. Rerankers run on a LOCAL
// Ollama (not the Cloud catalog), so this defaults to the embed URL (the local
// box already serving embeddings) unless explicitly overridden.
func (c *Client) rerankBaseURL() string {
	if c.cfg.RerankURL != "" {
		return c.cfg.RerankURL
	}
	return c.embedURL()
}

type rerankRequest struct {
	Model       string        `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens"`
	Logprobs    bool          `json:"logprobs"`
	TopLogprobs int           `json:"top_logprobs"`
}

type rerankResponse struct {
	Choices []struct {
		Message  ChatMessage     `json:"message"`
		Logprobs *rerankLogprobs `json:"logprobs"`
	} `json:"choices"`
}

type rerankLogprobs struct {
	Content []struct {
		Token       string `json:"token"`
		TopLogprobs []struct {
			Token   string  `json:"token"`
			Logprob float64 `json:"logprob"`
		} `json:"top_logprobs"`
	} `json:"content"`
}

// Rerank scores each document's relevance to query in [0,1] using the configured
// cross-encoder reranker (Qwen3-Reranker family) on the local reranker URL,
// returning one score per doc in the same order.
//
// Returns (nil, 0, nil) when no reranker model is configured — callers then skip
// reranking and keep their existing order. The middle return is the COUNT of docs
// that actually scored (a successful pair call); callers use it to detect partial
// coverage (a slow/saturated reranker that only scored a subset before the budget
// fired — the rest sink to 0) and decide whether the ranking is trustworthy.
// Individual pair failures score 0 (that candidate just sinks); but if EVERY pair
// fails (reranker down/unreachable) it returns an error so the caller falls back
// wholesale to the un-reranked order rather than trusting an all-zero ranking.
func (c *Client) Rerank(ctx context.Context, query string, docs []string) ([]float64, int, error) {
	if c.cfg.RerankModel == "" || len(docs) == 0 {
		return nil, 0, nil
	}
	scores := make([]float64, len(docs))
	var ok int32
	sem := make(chan struct{}, rerankConcurrency)
	var wg sync.WaitGroup
	for i := range docs {
		if ctx.Err() != nil {
			break // batch budget blown — stop launching; launched pairs observe ctx
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			s, err := c.rerankPair(ctx, query, docs[i])
			if err != nil {
				scores[i] = 0
				return
			}
			atomic.AddInt32(&ok, 1)
			scores[i] = s
		}(i)
	}
	wg.Wait()
	if ok == 0 {
		return nil, 0, fmt.Errorf("reranker %q scored no documents (unreachable?)", c.cfg.RerankModel)
	}
	return scores, int(ok), nil
}

// rerankPair scores one (query, document) pair. Best-effort: any transport or
// decode failure returns an error that Rerank treats as a 0 for that pair.
func (c *Client) rerankPair(ctx context.Context, query, doc string) (float64, error) {
	body, err := json.Marshal(rerankRequest{
		Model: c.cfg.RerankModel,
		Messages: []ChatMessage{
			{Role: "system", Content: rerankJudgeSystem},
			{Role: "user", Content: "Query: " + query + "\nDocument: " + doc},
		},
		Temperature: 0,
		MaxTokens:   2,
		Logprobs:    true,
		TopLogprobs: 20,
	})
	if err != nil {
		return 0, err
	}
	pctx, cancel := context.WithTimeout(ctx, rerankPairTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(pctx, http.MethodPost, c.rerankBaseURL()+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	// Only attach the bearer when an EXPLICIT reranker URL is set (a remote,
	// possibly-authed endpoint). Never leak the Cloud key to the default local
	// reranker box — mirrors the embed path, which omits auth for the local URL.
	if c.cfg.APIKey != "" && c.cfg.RerankURL != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, fmt.Errorf("rerank: %w", err)
	}
	defer resp.Body.Close()
	raw, capErr := readCappedBody(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("rerank: status %d: %s", resp.StatusCode, snippet(raw, 256))
	}
	if capErr != nil {
		return 0, capErr
	}
	var out rerankResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return 0, fmt.Errorf("rerank: decode: %w", err)
	}
	return scoreFromRerankResponse(&out), nil
}

// scoreFromRerankResponse turns a reranker reply into a [0,1] relevance score.
// Preferred path: softmax over the "yes"/"no" logprobs of the first generated
// token (a graded score). Fallback when the Ollama build returns no logprobs:
// binary from the generated text ("yes…" → 1, else 0). Pure function — unit
// tested directly.
func scoreFromRerankResponse(out *rerankResponse) float64 {
	if out == nil || len(out.Choices) == 0 {
		return 0
	}
	ch := out.Choices[0]
	if ch.Logprobs != nil && len(ch.Logprobs.Content) > 0 {
		lpYes, okYes := 0.0, false
		lpNo, okNo := 0.0, false
		for _, t := range ch.Logprobs.Content[0].TopLogprobs {
			switch strings.ToLower(strings.TrimSpace(t.Token)) {
			case "yes":
				if !okYes || t.Logprob > lpYes {
					lpYes, okYes = t.Logprob, true
				}
			case "no":
				if !okNo || t.Logprob > lpNo {
					lpNo, okNo = t.Logprob, true
				}
			}
		}
		if okYes || okNo {
			// If one side is absent from the top-k, treat it as far less likely
			// than the side we did see rather than assuming 50/50.
			if !okYes {
				lpYes = lpNo - 20
			}
			if !okNo {
				lpNo = lpYes - 20
			}
			ey, en := math.Exp(lpYes), math.Exp(lpNo)
			if ey+en == 0 {
				return 0
			}
			return ey / (ey + en)
		}
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(ch.Message.Content)), "yes") {
		return 1.0
	}
	return 0.0
}
