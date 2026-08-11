package matchreport

import (
	"math"
	"sort"
	"time"

	"github.com/aurora-media/aurora/internal/db"
)

const SchemaVersion = "aurora-match-report-v2"

type Report struct {
	SchemaVersion string        `json:"schema_version"`
	GeneratedAt   time.Time     `json:"generated_at"`
	Since         time.Time     `json:"since"`
	Days          int           `json:"days"`
	MinimumGroup  int           `json:"minimum_group_size"`
	Truncated     bool          `json:"truncated"`
	Selection     string        `json:"selection"`
	ExposureCount *int          `json:"qualified_exposures,omitempty"`
	ProfileCount  *int          `json:"distinct_profiles,omitempty"`
	ObservedCount *int          `json:"observed_outcomes,omitempty"`
	CensoredCount *int          `json:"censored_outcomes,omitempty"`
	Coverage      *float64      `json:"outcome_coverage,omitempty"`
	Metrics       *Metrics      `json:"observed_metrics,omitempty"`
	Models        []Group       `json:"models"`
	Labels        []Group       `json:"label_reasons"`
	MatchBins     []Calibration `json:"match_bins"`
	Warnings      []string      `json:"warnings"`
}

type Metrics struct {
	MeanPrediction float64 `json:"mean_prediction"`
	MeanOutcome    float64 `json:"mean_outcome"`
	BrierScore     float64 `json:"brier_score"`
	LogLoss        float64 `json:"log_loss"`
	ECE            float64 `json:"expected_calibration_error"`
}

type Group struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type Calibration struct {
	From           int     `json:"from_percent"`
	To             int     `json:"to_percent"`
	Count          int     `json:"count"`
	MeanPrediction float64 `json:"mean_prediction"`
	MeanOutcome    float64 `json:"mean_outcome"`
	AbsoluteGap    float64 `json:"absolute_gap"`
}

func Build(rows []db.RecommendationCalibrationRow, now, since time.Time, days, minimumGroup int, truncated bool) Report {
	if minimumGroup < 1 {
		minimumGroup = 1
	}
	r := Report{SchemaVersion: SchemaVersion, GeneratedAt: now.UTC(), Since: since.UTC(), Days: days, MinimumGroup: minimumGroup, Truncated: truncated, Selection: "oldest_qualified_exposures_first"}
	modelCounts := map[string]int{}
	profileIDs := map[int64]struct{}{}
	labelCounts := map[string]int{}
	type accumulator struct {
		n                   int
		prediction, outcome float64
	}
	bins := [10]accumulator{}
	var observedCount int
	var predictionSum, outcomeSum, squaredError, logLoss float64
	for _, row := range rows {
		modelCounts[row.ModelVersion]++
		profileIDs[row.ProfileID] = struct{}{}
		if !row.Observed {
			continue
		}
		observedCount++
		labelCounts[row.LabelReason]++
		p := math.Max(1e-6, math.Min(1-1e-6, float64(row.Match)/100))
		y := math.Max(0, math.Min(1, row.Label))
		predictionSum += p
		outcomeSum += y
		squaredError += (p - y) * (p - y)
		logLoss += -(y*math.Log(p) + (1-y)*math.Log(1-p))
		index := row.Match / 10
		if index > 9 {
			index = 9
		}
		bins[index].n++
		bins[index].prediction += p
		bins[index].outcome += y
	}
	censoredCount := len(rows) - observedCount
	if len(rows) >= minimumGroup {
		exposureCount := len(rows)
		r.ExposureCount = &exposureCount
		if len(profileIDs) >= minimumGroup {
			profileCount := len(profileIDs)
			r.ProfileCount = &profileCount
		}
		r.Models = privateGroups(modelCounts, minimumGroup)
	}
	partitionsPrivate := (observedCount == 0 || observedCount >= minimumGroup) && (censoredCount == 0 || censoredCount >= minimumGroup)
	if len(rows) >= minimumGroup && partitionsPrivate {
		r.ObservedCount = &observedCount
		r.CensoredCount = &censoredCount
		coverage := float64(observedCount) / float64(len(rows))
		r.Coverage = &coverage
	}
	if observedCount >= minimumGroup {
		n := float64(observedCount)
		metrics := Metrics{MeanPrediction: predictionSum / n, MeanOutcome: outcomeSum / n, BrierScore: squaredError / n, LogLoss: logLoss / n}
		for i, b := range bins {
			if b.n == 0 {
				continue
			}
			prediction := b.prediction / float64(b.n)
			outcome := b.outcome / float64(b.n)
			gap := math.Abs(prediction - outcome)
			metrics.ECE += float64(b.n) / n * gap
			if b.n < minimumGroup {
				continue
			}
			r.MatchBins = append(r.MatchBins, Calibration{From: i * 10, To: i*10 + 9, Count: b.n, MeanPrediction: prediction, MeanOutcome: outcome, AbsoluteGap: gap})
		}
		r.Metrics = &metrics
		r.Labels = privateGroups(labelCounts, minimumGroup)
	}
	if len(rows) == 0 {
		r.Warnings = append(r.Warnings, "No qualified exposures were found in the selected window.")
	} else if len(rows) < minimumGroup || observedCount < minimumGroup {
		r.Warnings = append(r.Warnings, "Observed outcomes are below the privacy threshold; outcome counts and metrics are suppressed.")
	} else if observedCount < 100 {
		r.Warnings = append(r.Warnings, "Fewer than 100 observed outcomes: metrics are descriptive only and too unstable for model fitting or production calibration claims.")
	}
	if truncated {
		r.Warnings = append(r.Warnings, "Result limit reached: metrics cover the oldest qualified exposures in the requested window, not the full window.")
	}
	if len(r.MatchBins) < 3 {
		r.Warnings = append(r.Warnings, "Fewer than three Match-score bands contain enough observed outcomes to meet the privacy threshold; this refers to calibration bands, not users. Collect more attributable outcomes before interpreting ECE.")
	}
	return r
}

func privateGroups(counts map[string]int, minimum int) []Group {
	groups := make([]Group, 0, len(counts)+1)
	suppressed := 0
	for name, count := range counts {
		if count < minimum {
			suppressed += count
			continue
		}
		groups = append(groups, Group{Name: name, Count: count})
	}
	if suppressed >= minimum {
		groups = append(groups, Group{Name: "suppressed_small_groups", Count: suppressed})
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].Count == groups[j].Count {
			return groups[i].Name < groups[j].Name
		}
		return groups[i].Count > groups[j].Count
	})
	return groups
}
