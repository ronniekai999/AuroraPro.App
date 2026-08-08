package api

import (
	"testing"
)

func TestValidUUID(t *testing.T) {
	if !validUUID("550e8400-e29b-41d4-a716-446655440000") {
		t.Error("canonical UUID should be valid")
	}
	for _, invalid := range []string{"", "550e8400e29b41d4a716446655440000", "550e8400-e29b-41d4-a716-44665544zzzz"} {
		if validUUID(invalid) {
			t.Errorf("validUUID(%q)=true", invalid)
		}
	}
}

func TestRecapQuestionHashStableAndQuestionBound(t *testing.T) {
	a := recapQuestionHash("  Who is Paige?  ")
	if a != recapQuestionHash("Who is Paige?") {
		t.Fatal("trim-equivalent questions should share an idempotency hash")
	}
	if a == recapQuestionHash("Who is Piper?") {
		t.Fatal("different questions must not share an idempotency hash")
	}
	if len(a) != 64 {
		t.Fatalf("hash length=%d, want 64", len(a))
	}
}
