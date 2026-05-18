package llm

import (
	"math"
	"strings"
	"testing"
)

func TestFormatVector_Empty(t *testing.T) {
	if got := FormatVector(nil); got != "" {
		t.Fatalf("FormatVector(nil) = %q, want empty string", got)
	}
}

func TestFormatVector_Shape(t *testing.T) {
	got := FormatVector([]float32{0.1, -0.5, 2.0})
	if !strings.HasPrefix(got, "[") || !strings.HasSuffix(got, "]") {
		t.Fatalf("missing brackets: %q", got)
	}
	if strings.Count(got, ",") != 2 {
		t.Fatalf("want 2 commas (3 dims): %q", got)
	}
}

func TestFormatVector_RoundTripExact(t *testing.T) {
	// 6-digit precision is what FormatVector encodes; values further out
	// truncate. Use values that survive the round-trip exactly.
	in := []float32{0.125, -0.5, 0.75}
	out, err := ParseVector(FormatVector(in))
	if err != nil {
		t.Fatalf("ParseVector failed: %v", err)
	}
	if len(out) != len(in) {
		t.Fatalf("dim mismatch: got %d, want %d", len(out), len(in))
	}
	for i := range in {
		if math.Abs(float64(in[i]-out[i])) > 1e-5 {
			t.Errorf("dim %d: got %v, want %v", i, out[i], in[i])
		}
	}
}

func TestParseVector_Empty_Errors(t *testing.T) {
	// The contract: empty literal "[]" must error, not return (nil, nil).
	// Callers rely on err != nil to skip a candidate, and a silent empty
	// return would be ambiguous ("no error, but also no vector").
	_, err := ParseVector("[]")
	if err == nil {
		t.Fatal("ParseVector(\"[]\") returned nil err, want error")
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Errorf("error message should mention 'empty': %q", err.Error())
	}
}

func TestParseVector_Malformed(t *testing.T) {
	cases := []string{
		"",
		"not a vector",
		"[1,2,3",   // missing close bracket
		"1,2,3]",   // missing open bracket
		"[1,abc,3]", // non-numeric element
		"[1,,3]",    // empty element
	}
	for _, s := range cases {
		if _, err := ParseVector(s); err == nil {
			t.Errorf("ParseVector(%q) returned nil err, want error", s)
		}
	}
}

func TestParseVector_Whitespace(t *testing.T) {
	// pgvector emits no whitespace, but defensive parsing should tolerate
	// surrounding whitespace from caller-side processing.
	cases := []string{
		"[0.5,0.5]",
		" [0.5,0.5] ",
		"\t[0.5,0.5]\n",
	}
	for _, s := range cases {
		v, err := ParseVector(s)
		if err != nil {
			t.Errorf("ParseVector(%q) failed: %v", s, err)
			continue
		}
		if len(v) != 2 {
			t.Errorf("ParseVector(%q): want 2 dims, got %d", s, len(v))
		}
	}
}

func TestParseVector_InteriorWhitespace(t *testing.T) {
	// "[0.1, 0.2, 0.3]" — space after each comma. Should still parse.
	v, err := ParseVector("[0.1, 0.2, 0.3]")
	if err != nil {
		t.Fatalf("ParseVector with interior whitespace failed: %v", err)
	}
	if len(v) != 3 {
		t.Fatalf("want 3 dims, got %d", len(v))
	}
}

func TestParseVector_LargeDim(t *testing.T) {
	// Realistic pgvector text literal at the 384-dim size Aurora uses.
	var b strings.Builder
	b.WriteByte('[')
	for i := 0; i < 384; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString("0.001")
	}
	b.WriteByte(']')
	v, err := ParseVector(b.String())
	if err != nil {
		t.Fatalf("384-dim parse failed: %v", err)
	}
	if len(v) != 384 {
		t.Fatalf("want 384 dims, got %d", len(v))
	}
}
