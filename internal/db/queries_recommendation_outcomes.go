package db

import (
	"context"
	"fmt"
	"time"
)

const (
	SatisfactionCompletedUnrated = 0.75
	SatisfactionThumbUp          = 0.85
	SatisfactionEarlyAbandon     = 0.20
	SatisfactionSustainedPartial = 0.55
	SatisfactionRewatch          = 0.90
)

// RecommendationOutcomeSignals are series-level behavioral and explicit
// signals observed after one visible recommendation. For shows all episode rows
// aggregate under the parent media_item_id; an episode is never modeled as an
// independent taste outcome.
type RecommendationOutcomeSignals struct {
	MediaType          string
	Stars              int
	RatingAt           *time.Time
	Feedback           string
	FeedbackAt         *time.Time
	FreshCompletions   int
	RewatchCompletions int
	EngagedRows        int
	MaxProgress        float64
	EarlyAbandoned     bool
}

// SatisfactionLabel applies the beta policy approved for Match v2. Explicit
// feedback wins, with the most recent explicit verdict winning when a star and
// thumb conflict. Rewatches are stronger than first completion. Show behavior is
// aggregated at series level and needs two engaged/completed episodes before a
// completion-strength label; a single episode remains sustained-partial evidence.
func SatisfactionLabel(s RecommendationOutcomeSignals) (value float64, observed bool, reason string) {
	if s.Stars > 0 || s.Feedback != "" {
		useRating := s.Stars > 0
		if s.FeedbackAt != nil && (s.RatingAt == nil || s.FeedbackAt.After(*s.RatingAt)) {
			useRating = false
		}
		if useRating {
			switch s.Stars {
			case 5:
				return 1, true, "rated_5"
			case 4:
				return .85, true, "rated_4"
			case 3:
				return .50, true, "rated_3"
			case 2:
				return .10, true, "rated_2"
			case 1:
				return 0, true, "rated_1"
			}
		}
		if s.Feedback == "up" {
			return SatisfactionThumbUp, true, "thumb_up"
		}
		if s.Feedback == "down" {
			return 0, true, "thumb_down"
		}
	}
	if s.RewatchCompletions > 0 {
		return SatisfactionRewatch, true, "rewatch"
	}
	if s.MediaType == "show" {
		if s.FreshCompletions >= 2 || (s.EngagedRows >= 2 && s.MaxProgress >= .20) {
			return SatisfactionCompletedUnrated, true, "series_engaged"
		}
		if s.FreshCompletions == 1 {
			return SatisfactionSustainedPartial, true, "series_one_episode"
		}
	} else if s.FreshCompletions > 0 {
		return SatisfactionCompletedUnrated, true, "completed_unrated"
	}
	if s.EarlyAbandoned {
		return SatisfactionEarlyAbandon, true, "abandoned_under_20pct"
	}
	if s.EngagedRows > 0 && s.MaxProgress >= .20 {
		return SatisfactionSustainedPartial, true, "sustained_partial"
	}
	return 0, false, "censored"
}

type RecommendationCalibrationRow struct {
	ImpressionID int64
	ProfileID    int64
	MediaItemID  int64
	VisibleAt    time.Time
	Match        int
	Confidence   float64
	ModelVersion string
	Similarity   float64
	Evidence     int
	Signals      RecommendationOutcomeSignals
	Label        float64
	Observed     bool
	LabelReason  string
}

// Predicted reports whether this exposure actually displayed a personal Match
// probability. Cold-start heroes are logged with the same fidelity as
// personalized ones (they are real exposures, and the surface mix matters), but
// they showed the viewer an Aurora Score — no probabilistic claim was made, so
// they belong to no calibration bucket. Scoring them anyway feeds Match=0 into
// Brier/log-loss as a confident "this will disappoint you": one satisfied
// cold-start outcome adds ~10 to summed log loss, which on a beta-sized cohort
// swamps the very metrics the report exists to produce.
func (r RecommendationCalibrationRow) Predicted() bool {
	return r.Match > 0 && r.ModelVersion != "" && r.ModelVersion != UnpersonalizedModelVersion
}

// RecommendationCalibrationRows returns visible, reproducible decisions plus
// all currently observable post-exposure outcomes. It deliberately leaves
// no-action rows censored; callers choose an attribution/maturity window rather
// than training on absence as a dislike.
func (q *Queries) RecommendationCalibrationRows(ctx context.Context, since time.Time, limit int) ([]RecommendationCalibrationRow, error) {
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	rows, err := q.pool.Query(ctx, `
		WITH exposures AS (
		  SELECT i.*,
		         LEAST(
		           COALESCE(LEAD(i.visible_at) OVER (
		             PARTITION BY i.profile_id, i.media_item_id ORDER BY i.visible_at, i.id
		           ), 'infinity'::timestamptz),
		           i.visible_at + INTERVAL '30 days'
		         ) AS window_end
		  FROM recommendation_impressions i
		  WHERE i.visible_at IS NOT NULL AND i.visible_at >= $1
		)
		SELECT i.id, i.profile_id, i.media_item_id, i.visible_at, i.match,
		       i.confidence, i.model_version, i.similarity, i.evidence, m.type,
		       COALESCE(ur.stars, 0), ur.updated_at,
		       COALESCE(fb.feedback, ''), fb.created_at,
		       COALESCE(p.fresh_completions, 0), COALESCE(p.rewatch_completions, 0),
		       COALESCE(p.engaged_rows, 0), COALESCE(p.max_progress, 0),
		       COALESCE(p.early_abandoned, FALSE)
		FROM exposures i
		JOIN media_items m ON m.id = i.media_item_id
		LEFT JOIN LATERAL (
		  SELECT stars, updated_at FROM user_ratings
		  WHERE profile_id=i.profile_id AND media_item_id=i.media_item_id
		    AND updated_at >= i.visible_at AND updated_at < i.window_end
		  ORDER BY updated_at DESC LIMIT 1
		) ur ON TRUE
		LEFT JOIN LATERAL (
		  SELECT feedback, created_at FROM item_feedback
		  WHERE profile_id=i.profile_id AND media_item_id=i.media_item_id
		    AND created_at >= i.visible_at AND created_at < i.window_end
		  ORDER BY created_at DESC LIMIT 1
		) fb ON TRUE
		LEFT JOIN LATERAL (
		  SELECT
		    COUNT(DISTINCT e.episode_id) FILTER (WHERE e.event_type='completed' AND e.episode_id IS NOT NULL)::int
		      + COUNT(*) FILTER (WHERE e.event_type='completed' AND e.episode_id IS NULL)::int AS fresh_completions,
		    COUNT(*) FILTER (WHERE e.event_type='rewatch_completed')::int AS rewatch_completions,
		    -- Engagement excludes 'started' (progress < 20%): the series label
		    -- promises TWO engaged/completed episodes, and counting bounces let
		    -- 25% of ep1 plus two minutes of ep2 read as 0.75 "series_engaged"
		    -- instead of 0.55 sustained-partial. The movie path is unchanged —
		    -- SatisfactionLabel already gated it on MaxProgress >= 0.20.
		    (COUNT(DISTINCT COALESCE(e.episode_id, e.id))
		      FILTER (WHERE e.event_type <> 'started'))::int AS engaged_rows,
		    MAX(e.progress) AS max_progress,
		    (ARRAY_AGG(e.event_type ORDER BY e.occurred_at DESC, e.id DESC))[1] = 'started'
		      AND MAX(e.occurred_at) <= NOW() - INTERVAL '30 minutes'
		      AND i.window_end >= MAX(e.occurred_at) + INTERVAL '30 minutes' AS early_abandoned
		  FROM recommendation_watch_events e
		  WHERE e.profile_id=i.profile_id AND e.media_item_id=i.media_item_id
		    AND e.occurred_at >= i.visible_at AND e.occurred_at < i.window_end
		) p ON TRUE
		ORDER BY i.visible_at ASC, i.id ASC
		LIMIT $2`, since, limit)
	if err != nil {
		return nil, fmt.Errorf("recommendation calibration rows: %w", err)
	}
	defer rows.Close()
	out := make([]RecommendationCalibrationRow, 0)
	for rows.Next() {
		var r RecommendationCalibrationRow
		if err := rows.Scan(
			&r.ImpressionID, &r.ProfileID, &r.MediaItemID, &r.VisibleAt, &r.Match,
			&r.Confidence, &r.ModelVersion, &r.Similarity, &r.Evidence, &r.Signals.MediaType,
			&r.Signals.Stars, &r.Signals.RatingAt, &r.Signals.Feedback, &r.Signals.FeedbackAt,
			&r.Signals.FreshCompletions, &r.Signals.RewatchCompletions,
			&r.Signals.EngagedRows, &r.Signals.MaxProgress, &r.Signals.EarlyAbandoned,
		); err != nil {
			return nil, fmt.Errorf("scan recommendation calibration row: %w", err)
		}
		r.Label, r.Observed, r.LabelReason = SatisfactionLabel(r.Signals)
		out = append(out, r)
	}
	return out, rows.Err()
}
