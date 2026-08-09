package db

import (
	"context"
	"fmt"
	"math"
	"time"
)

const RecommendationImpressionRetention = 90 * 24 * time.Hour

// RecommendationImpression is one item in a recommendation slate selected for
// API delivery. Position is zero-based. Similarity and Evidence are the raw
// Match-model inputs; Match and Confidence are the derived values shown/logged.
type RecommendationImpression struct {
	MediaItemID  int64
	Position     int
	Match        int
	Confidence   float64
	ModelVersion string
	Similarity   float64
	Evidence     int
}

// RecordRecommendationImpressions stores a delivered-slate proxy for later,
// time-forward calibration analysis. One CTE creates the slate and batch-inserts
// all valid positions, keeping the detached analytics path to one round trip.
func (q *Queries) RecordRecommendationImpressions(ctx context.Context, profileID int64, surface, slateToken string, items []RecommendationImpression) error {
	if profileID <= 0 || surface == "" || slateToken == "" || len(items) == 0 {
		return nil
	}
	mediaIDs := make([]int64, 0, len(items))
	positions := make([]int32, 0, len(items))
	matches := make([]int16, 0, len(items))
	confidences := make([]float64, 0, len(items))
	versions := make([]string, 0, len(items))
	similarities := make([]float64, 0, len(items))
	evidence := make([]int32, 0, len(items))
	for _, item := range items {
		if item.MediaItemID <= 0 || item.Position < 0 || math.IsNaN(item.Confidence) || math.IsInf(item.Confidence, 0) || math.IsNaN(item.Similarity) || math.IsInf(item.Similarity, 0) {
			continue
		}
		confidence := math.Max(0, math.Min(1, item.Confidence))
		similarity := math.Max(-1, math.Min(1, item.Similarity))
		match := item.Match
		if match < 0 {
			match = 0
		} else if match > 100 {
			match = 100
		}
		version := item.ModelVersion
		if version == "" {
			version = "unpersonalized"
		}
		n := item.Evidence
		if n < 0 {
			n = 0
		}
		mediaIDs = append(mediaIDs, item.MediaItemID)
		positions = append(positions, int32(item.Position))
		matches = append(matches, int16(match))
		confidences = append(confidences, confidence)
		versions = append(versions, version)
		similarities = append(similarities, similarity)
		evidence = append(evidence, int32(n))
	}
	if len(mediaIDs) == 0 {
		return nil
	}
	if _, err := q.pool.Exec(ctx, `
		WITH slate AS (
		  INSERT INTO recommendation_slates (profile_id, surface, slate_token)
		  VALUES ($1, $2, $3)
		  RETURNING id
		)
		INSERT INTO recommendation_impressions
		  (slate_id, profile_id, media_item_id, position, match, confidence,
		   model_version, similarity, evidence)
		SELECT slate.id, $1, u.media_item_id, u.position, u.match, u.confidence,
		       u.model_version, u.similarity, u.evidence
		FROM slate
		CROSS JOIN unnest($4::bigint[], $5::integer[], $6::smallint[],
		                  $7::float8[], $8::text[], $9::float8[], $10::integer[])
		  AS u(media_item_id, position, match, confidence, model_version, similarity, evidence)`,
		profileID, surface, slateToken, mediaIDs, positions, matches, confidences, versions, similarities, evidence,
	); err != nil {
		return fmt.Errorf("record recommendation impressions: %w", err)
	}
	return nil
}

// MarkRecommendationVisible promotes an API-selected impression to an observed
// exposure. Ownership is enforced in the UPDATE predicate. Repeated browser
// events keep the first visibility timestamp and the longest measured dwell.
// The bool is false when the async slate insert has not landed (or the token/item
// does not belong to the profile), allowing the client to retry once.
func (q *Queries) MarkRecommendationVisible(ctx context.Context, profileID int64, slateToken string, mediaItemID int64, position, visibleMs int) (bool, error) {
	// Enforce the product's qualified-exposure contract at the persistence
	// boundary too; callers other than the HTTP handler must not weaken the
	// calibration cohort.
	if visibleMs < 1500 {
		return false, nil
	}
	if profileID <= 0 || slateToken == "" || mediaItemID <= 0 || position < 0 {
		return false, nil
	}
	if visibleMs < 0 {
		visibleMs = 0
	}
	tag, err := q.pool.Exec(ctx, `
		UPDATE recommendation_impressions i
		SET visible_at = COALESCE(i.visible_at, NOW()),
		    visible_ms = GREATEST(COALESCE(i.visible_ms, 0), $5)
		FROM recommendation_slates s
		WHERE s.id = i.slate_id
		  AND s.profile_id = $1
		  AND s.slate_token = $2
		  AND i.media_item_id = $3
		  AND i.position = $4`,
		profileID, slateToken, mediaItemID, position, visibleMs,
	)
	if err != nil {
		return false, fmt.Errorf("mark recommendation visible: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// PruneRecommendationImpressions enforces raw-history retention independently
// of recommendation traffic. It also removes empty slates left when every media
// child was deleted. The server calls this at startup and every 24 hours.
func (q *Queries) PruneRecommendationImpressions(ctx context.Context, retention time.Duration) (int64, error) {
	if retention <= 0 {
		return 0, nil
	}
	var deletedSlates int64
	err := q.pool.QueryRow(ctx, `
		WITH pruned_events AS (
		  DELETE FROM recommendation_watch_events
		  WHERE occurred_at < NOW() - INTERVAL '1 second' * $1
		), pruned_slates AS (
		  DELETE FROM recommendation_slates s
		  WHERE s.created_at < NOW() - INTERVAL '1 second' * $1
		     OR NOT EXISTS (SELECT 1 FROM recommendation_impressions i WHERE i.slate_id = s.id)
		  RETURNING 1
		)
		SELECT COUNT(*) FROM pruned_slates`, int64(retention.Seconds())).Scan(&deletedSlates)
	if err != nil {
		return 0, fmt.Errorf("prune recommendation impressions: %w", err)
	}
	return deletedSlates, nil
}
