package db

import (
	"testing"
	"time"
)

func TestSatisfactionLabelPolicy(t *testing.T) {
	now := time.Now()
	later := now.Add(time.Minute)
	tests := []struct {
		name     string
		in       RecommendationOutcomeSignals
		want     float64
		observed bool
		reason   string
	}{
		{"completed unrated movie", RecommendationOutcomeSignals{MediaType: "movie", FreshCompletions: 1}, .75, true, "completed_unrated"},
		{"thumb up means seen", RecommendationOutcomeSignals{Feedback: "up", FeedbackAt: &now}, .85, true, "thumb_up"},
		{"mature early abandon under 20", RecommendationOutcomeSignals{EngagedRows: 1, MaxProgress: .19, EarlyAbandoned: true}, .20, true, "abandoned_under_20pct"},
		{"active early playback is censored", RecommendationOutcomeSignals{EngagedRows: 1, MaxProgress: .19}, 0, false, "censored"},
		{"twenty percent sustained", RecommendationOutcomeSignals{EngagedRows: 1, MaxProgress: .20}, .55, true, "sustained_partial"},
		{"show one episode", RecommendationOutcomeSignals{MediaType: "show", FreshCompletions: 1}, .55, true, "series_one_episode"},
		{"show series engagement", RecommendationOutcomeSignals{MediaType: "show", EngagedRows: 2, MaxProgress: .6}, .75, true, "series_engaged"},
		{"show mature early abandon", RecommendationOutcomeSignals{MediaType: "show", EngagedRows: 2, MaxProgress: .10, EarlyAbandoned: true}, .20, true, "abandoned_under_20pct"},
		{"rewatch stronger", RecommendationOutcomeSignals{RewatchCompletions: 1}, .90, true, "rewatch"},
		{"latest explicit wins", RecommendationOutcomeSignals{Stars: 1, RatingAt: &now, Feedback: "up", FeedbackAt: &later}, .85, true, "thumb_up"},
		{"no action censored", RecommendationOutcomeSignals{}, 0, false, "censored"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, observed, reason := SatisfactionLabel(tt.in)
			if got != tt.want || observed != tt.observed || reason != tt.reason {
				t.Fatalf("got (%v,%v,%q), want (%v,%v,%q)", got, observed, reason, tt.want, tt.observed, tt.reason)
			}
		})
	}
}
