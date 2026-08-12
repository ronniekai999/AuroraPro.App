package matchreport

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/db"
)

func TestBuildCalibrationReport(t *testing.T) {
	now := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	rows := []db.RecommendationCalibrationRow{
		{ProfileID: 1, Match: 80, ModelVersion: "v1", Observed: true, Label: 1, LabelReason: "rated_5"},
		{ProfileID: 2, Match: 80, ModelVersion: "v1", Observed: true, Label: 0, LabelReason: "thumb_down"},
		{ProfileID: 3, Match: 40, ModelVersion: "rare", Observed: false, LabelReason: "censored"},
	}
	report := Build(rows, now, now.Add(-90*24*time.Hour), 90, 2, false)
	if report.ExposureCount == nil || *report.ExposureCount != 3 || report.ProfileCount == nil || *report.ProfileCount != 3 || report.ObservedCount != nil || report.CensoredCount != nil {
		t.Fatalf("privacy-partitioned counts = %+v/%+v/%+v", report.ExposureCount, report.ObservedCount, report.CensoredCount)
	}
	if report.Metrics == nil || math.Abs(report.Metrics.BrierScore-.34) > 1e-9 || math.Abs(report.Metrics.MeanOutcome-.5) > 1e-9 {
		t.Fatalf("metrics = %+v", report.Metrics)
	}
	if len(report.MatchBins) != 1 || report.MatchBins[0].Count != 2 || math.Abs(report.MatchBins[0].AbsoluteGap-.3) > 1e-9 {
		t.Fatalf("bins = %+v", report.MatchBins)
	}
	if len(report.Models) != 1 || report.Models[0].Name != "v1" {
		t.Fatalf("privacy groups = %+v", report.Models)
	}
}

func TestBuildCountsDistinctProfilesAndSuppressesSmallProfileCohort(t *testing.T) {
	now := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	rows := []db.RecommendationCalibrationRow{
		{ProfileID: 1, ModelVersion: "v1"},
		{ProfileID: 1, ModelVersion: "v1"},
		{ProfileID: 2, ModelVersion: "v1"},
	}
	report := Build(rows, now, now.Add(-24*time.Hour), 1, 2, false)
	if report.ProfileCount == nil || *report.ProfileCount != 2 {
		t.Fatalf("distinct profile count = %v, want 2", report.ProfileCount)
	}

	report = Build(rows, now, now.Add(-24*time.Hour), 1, 3, false)
	if report.ExposureCount == nil || report.ProfileCount != nil {
		t.Fatalf("privacy-bounded counts = exposures %v, profiles %v", report.ExposureCount, report.ProfileCount)
	}
}

// TestBuildExcludesUnpredictedExposuresFromMetrics pins the calibration cohort.
// Cold-start heroes are logged as real exposures but display the global Aurora
// Score, not a Match — scoring them treats "no claim" as a confident 0%
// prediction, which on a beta-sized cohort dominates exactly the metrics the
// report exists to produce. The predicted rows here are the same two as
// TestBuildCalibrationReport, so every metric must come out identical.
func TestBuildExcludesUnpredictedExposuresFromMetrics(t *testing.T) {
	now := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	rows := []db.RecommendationCalibrationRow{
		{ProfileID: 1, Match: 80, ModelVersion: "match-v2-bootstrap-2", Observed: true, Label: 1, LabelReason: "rated_5"},
		{ProfileID: 2, Match: 80, ModelVersion: "match-v2-bootstrap-2", Observed: true, Label: 0, LabelReason: "thumb_down"},
		// Satisfying cold-start outcomes: unscored, but loudly wrong if scored.
		{ProfileID: 3, Match: 0, ModelVersion: db.UnpersonalizedModelVersion, Observed: true, Label: 1, LabelReason: "rated_5"},
		{ProfileID: 4, Match: 0, ModelVersion: db.UnpersonalizedModelVersion, Observed: true, Label: 1, LabelReason: "rated_5"},
	}
	report := Build(rows, now, now.Add(-90*24*time.Hour), 90, 2, false)

	if report.Metrics == nil {
		t.Fatal("metrics missing")
	}
	if math.Abs(report.Metrics.BrierScore-.34) > 1e-9 || math.Abs(report.Metrics.MeanOutcome-.5) > 1e-9 {
		t.Fatalf("unpredicted rows moved the metrics: %+v", report.Metrics)
	}
	// Scoring p≈0 against a satisfied outcome adds ~13.8 each to summed log
	// loss; the predicted-only mean is ~0.92.
	if report.Metrics.LogLoss > 1 {
		t.Fatalf("log loss = %v, want the predicted-only ~0.92", report.Metrics.LogLoss)
	}
	if len(report.MatchBins) != 1 || report.MatchBins[0].From != 80 || report.MatchBins[0].Count != 2 {
		t.Fatalf("unpredicted rows leaked into the calibration bands: %+v", report.MatchBins)
	}

	// The exclusion has to be visible, not silent: qualified counts everything,
	// predicted is the metrics cohort, and coverage is a share of the latter.
	if report.ExposureCount == nil || *report.ExposureCount != 4 {
		t.Fatalf("qualified exposures = %v, want all 4", report.ExposureCount)
	}
	if report.PredictedCount == nil || *report.PredictedCount != 2 || report.UnpredictedCount == nil || *report.UnpredictedCount != 2 {
		t.Fatalf("prediction split = %v/%v, want 2/2", report.PredictedCount, report.UnpredictedCount)
	}
	if report.Coverage == nil || math.Abs(*report.Coverage-1) > 1e-9 {
		t.Fatalf("coverage = %v, want 1 (both predicted rows observed)", report.Coverage)
	}
	if !hasWarningContaining(report, "excluded from the metrics") {
		t.Fatalf("exclusion is not disclosed: %v", report.Warnings)
	}
}

// A window with nothing but cold-start traffic has nothing to calibrate. It
// must say so rather than reporting a perfect-looking zero-error model.
func TestBuildAllUnpredictedHasNothingToCalibrate(t *testing.T) {
	now := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	rows := []db.RecommendationCalibrationRow{
		{ProfileID: 1, Match: 0, ModelVersion: db.UnpersonalizedModelVersion, Observed: true, Label: 1, LabelReason: "rated_5"},
		{ProfileID: 2, Match: 0, ModelVersion: db.UnpersonalizedModelVersion, Observed: true, Label: .75, LabelReason: "completed_unrated"},
	}
	report := Build(rows, now, now.Add(-24*time.Hour), 1, 2, false)
	if report.Metrics != nil || len(report.MatchBins) != 0 {
		t.Fatalf("unpredicted-only window produced metrics: %+v / %+v", report.Metrics, report.MatchBins)
	}
	if report.PredictedCount == nil || *report.PredictedCount != 0 {
		t.Fatalf("predicted exposures = %v, want 0", report.PredictedCount)
	}
	if !hasWarningContaining(report, "nothing to calibrate") {
		t.Fatalf("missing the no-predictions warning: %v", report.Warnings)
	}
}

func hasWarningContaining(r Report, substr string) bool {
	for _, w := range r.Warnings {
		if strings.Contains(w, substr) {
			return true
		}
	}
	return false
}

func TestBuildEmptyReport(t *testing.T) {
	report := Build(nil, time.Now(), time.Now().Add(-24*time.Hour), 1, 5, false)
	if report.ExposureCount != nil || len(report.Warnings) < 2 {
		t.Fatalf("empty report = %+v", report)
	}
}

func TestBuildSuppressesBelowKAndSerializesOnlyAggregates(t *testing.T) {
	now := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	row := db.RecommendationCalibrationRow{ProfileID: 987654321012345, MediaItemID: 876543210123456, Match: 87, ModelVersion: "secret-model", Observed: true, Label: .85, LabelReason: "thumb_up"}
	report := Build([]db.RecommendationCalibrationRow{row}, now, now.Add(-24*time.Hour), 1, 5, true)
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, forbidden := range []string{"987654321012345", "876543210123456", "0.87", "0.85", "secret-model", "thumb_up", `"observed_metrics":`, `"qualified_exposures":`, `"distinct_profiles":`} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("below-k JSON leaked %q: %s", forbidden, text)
		}
	}
	if !report.Truncated || !strings.Contains(text, "oldest_qualified_exposures_first") {
		t.Fatalf("truncation metadata missing: %s", text)
	}
}
