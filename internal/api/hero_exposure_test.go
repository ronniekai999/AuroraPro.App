package api

import "testing"

func TestNewRecommendationSlateToken(t *testing.T) {
	a := newRecommendationSlateToken()
	b := newRecommendationSlateToken()
	if len(a) != 32 || len(b) != 32 {
		t.Fatalf("token lengths = %d/%d, want 32", len(a), len(b))
	}
	if a == b {
		t.Fatal("independent slate tokens collided")
	}
}
