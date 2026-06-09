package llm

import (
	"fmt"
	"strconv"
	"strings"
)

// FormatVector renders a Go float32 slice as the literal pgvector accepts:
//
//	"[0.123,-0.456,...]"
//
// We use the text protocol rather than introducing pgx custom-type wiring —
// pgvector's text format is unambiguous, and the dependency footprint stays at
// just `pg_trgm` + `vector` server-side. The formatted string is passed as a
// regular SQL parameter; pgvector casts on the receiving column.
func FormatVector(v []float32) string {
	if v == nil {
		return ""
	}
	var b strings.Builder
	b.Grow(len(v) * 10)
	b.WriteByte('[')
	for i, x := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(x), 'f', 6, 32))
	}
	b.WriteByte(']')
	return b.String()
}

// ParseVector is the inverse of FormatVector: it decodes pgvector's text
// representation ("[0.1,0.2,...]") back into a []float32. Used by callers
// (e.g. recommender MMR diversification + anchor matching) that need the
// raw embedding bytes for Go-side similarity math, not just an SQL operand.
//
// Returns an error for malformed input rather than partial parsing —
// silent corruption of an embedding would propagate quietly into
// downstream similarity scores.
//
// Contract: a nil error guarantees a non-empty result. An empty literal
// ("[]") is rejected with an error rather than `(nil, nil)`, because for
// every legitimate caller in this codebase a zero-dim vector is a bug
// upstream — embeddings are fixed-width by construction (768-dim as of
// Phase E2), so "[]" means we scanned a column where the embedding was NULL
// or the row was malformed.
// Callers should treat the error path as "skip this candidate."
func ParseVector(s string) ([]float32, error) {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "[") || !strings.HasSuffix(s, "]") {
		return nil, fmt.Errorf("not a pgvector text literal")
	}
	s = s[1 : len(s)-1]
	if s == "" {
		return nil, fmt.Errorf("empty pgvector literal")
	}
	parts := strings.Split(s, ",")
	out := make([]float32, len(parts))
	for i, p := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(p), 32)
		if err != nil {
			return nil, fmt.Errorf("parse dim %d: %w", i, err)
		}
		out[i] = float32(v)
	}
	return out, nil
}
