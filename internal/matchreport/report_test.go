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
