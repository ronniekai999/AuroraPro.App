package db

import (
	"context"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
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

// TestCalibrationRowsSeriesEngagementIgnoresBounces is the SQL half of the
// series policy: engaged_rows counts engaged/completed episodes, never
// 'started' bounces. One real episode plus a two-minute sample of the next is
// sustained-partial evidence (0.55), not the 0.75 "they're into this series"
// label the row count used to produce. Opt-in via TEST_DATABASE_URL.
func TestCalibrationRowsSeriesEngagementIgnoresBounces(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	showID := seedTestMediaItem(t, q, libID)
	if _, err := q.pool.Exec(ctx, `UPDATE media_items SET type = 'show' WHERE id = $1`, showID); err != nil {
		t.Fatalf("make show: %v", err)
	}
	episodes := seedShowWithEpisodes(t, q, showID, 2)

	// The exposure has to precede the watch events it attributes.
	const token = "series0000000000000000000engaged"
	if err := q.RecordRecommendationImpressions(ctx, profileID, "hero", token, []RecommendationImpression{
		{MediaItemID: showID, Position: 0, Match: 70, Confidence: .8, ModelVersion: "match-v2-bootstrap-2", Similarity: .8, Evidence: 12},
	}); err != nil {
		t.Fatalf("record impression: %v", err)
	}
	if ok, err := q.MarkRecommendationVisible(ctx, profileID, token, showID, 0, 2000); err != nil || !ok {
		t.Fatalf("mark visible: ok=%v err=%v", ok, err)
	}

	watch := func(episodeID int64, positionMs int64) {
		t.Helper()
		ep := episodeID
		if _, err := q.UpsertWatchProgress(ctx, &models.WatchProgress{
			UserID: userID, ProfileID: profileID, MediaItemID: showID,
			EpisodeID: &ep, PositionMs: positionMs, DurationMs: 100,
		}); err != nil {
			t.Fatalf("progress ep %d: %v", episodeID, err)
		}
	}
	watch(episodes[0], 25) // engaged — a real watch of episode 1
	watch(episodes[1], 5)  // started — sampled episode 2 and bounced

	rows, err := q.RecommendationCalibrationRows(ctx, time.Now().Add(-time.Hour), 100)
	if err != nil {
		t.Fatalf("calibration rows: %v", err)
	}
	var row *RecommendationCalibrationRow
	for i := range rows {
		if rows[i].MediaItemID == showID {
			row = &rows[i]
			break
		}
	}
	if row == nil {
		t.Fatal("visible exposure missing from the calibration cohort")
	}
	if row.Signals.EngagedRows != 1 {
		t.Errorf("engaged_rows = %d, want 1 — a 'started' bounce is not engagement", row.Signals.EngagedRows)
	}
	if row.LabelReason != "sustained_partial" || row.Label != SatisfactionSustainedPartial {
		t.Errorf("label = %v/%q, want %v/sustained_partial", row.Label, row.LabelReason, SatisfactionSustainedPartial)
	}
	if !row.Predicted() {
		t.Error("a row carrying a real Match and model version must be in the predicted cohort")
	}
}
