package db

import (
	"context"
	"math"
	"testing"
	"time"
)

// TestRecordRecommendationImpressions is opt-in with TEST_DATABASE_URL. It
// covers slate grouping, defensive clamping/skips, retention pruning, and the
// profile cascade that makes deletion/privacy semantics load-bearing.
func TestRecordRecommendationImpressions(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	item1 := seedTestMediaItem(t, q, libID)
	item2 := seedTestMediaItem(t, q, libID)

	if err := q.RecordRecommendationImpressions(ctx, profileID, "hero", "slate-test-0001", []RecommendationImpression{
		{MediaItemID: item1, Position: 0, Match: 120, Confidence: 2, ModelVersion: "test-v1", Similarity: 2, Evidence: 12},
		{MediaItemID: -1, Position: 1, Match: 50, Confidence: .5, ModelVersion: "skipped"},
		{MediaItemID: item2, Position: 2, Match: -5, Confidence: -1, ModelVersion: "test-v1", Similarity: -.5, Evidence: -3},
		{MediaItemID: item2, Position: 3, Match: 50, Confidence: math.NaN(), ModelVersion: "invalid"},
	}); err != nil {
		t.Fatalf("record impressions: %v", err)
	}

	var slates, impressions int
	if err := q.pool.QueryRow(ctx, `SELECT COUNT(*) FROM recommendation_slates WHERE profile_id=$1`, profileID).Scan(&slates); err != nil {
		t.Fatal(err)
	}
	if err := q.pool.QueryRow(ctx, `SELECT COUNT(*) FROM recommendation_impressions WHERE profile_id=$1`, profileID).Scan(&impressions); err != nil {
		t.Fatal(err)
	}
	if slates != 1 || impressions != 2 {
		t.Fatalf("want one slate/two valid impressions, got slates=%d impressions=%d", slates, impressions)
	}
	var hiMatch int
	var hiConfidence, hiSimilarity float64
	var hiEvidence int
	if err := q.pool.QueryRow(ctx, `SELECT match, confidence, similarity, evidence FROM recommendation_impressions WHERE profile_id=$1 AND position=0`, profileID).Scan(&hiMatch, &hiConfidence, &hiSimilarity, &hiEvidence); err != nil {
		t.Fatal(err)
	}
	if hiMatch != 100 || hiConfidence != 1 || hiSimilarity != 1 || hiEvidence != 12 {
		t.Fatalf("values not normalized/snapshotted: match=%d confidence=%v similarity=%v evidence=%d", hiMatch, hiConfidence, hiSimilarity, hiEvidence)
	}

	if _, err := q.pool.Exec(ctx, `UPDATE recommendation_slates SET created_at=NOW()-INTERVAL '100 days' WHERE profile_id=$1`, profileID); err != nil {
		t.Fatal(err)
	}
	if err := q.RecordRecommendationImpressions(ctx, profileID, "hero", "slate-test-0002", []RecommendationImpression{{MediaItemID: item1, Position: 0, Match: 60, Confidence: .5, ModelVersion: "test-v2", Similarity: .8, Evidence: 20}}); err != nil {
		t.Fatalf("record second slate: %v", err)
	}
	if _, err := q.pool.Exec(ctx, `
		INSERT INTO recommendation_watch_events (profile_id, media_item_id, event_type, progress, occurred_at)
		VALUES ($1,$2,'completed',1,NOW()-INTERVAL '100 days'),
		       ($1,$2,'completed',1,NOW())`, profileID, item1); err != nil {
		t.Fatalf("seed retained watch events: %v", err)
	}
	pruned, err := q.PruneRecommendationImpressions(ctx, RecommendationImpressionRetention)
	if err != nil {
		t.Fatalf("retention sweep: %v", err)
	}
	if pruned < 1 {
		t.Fatalf("retention sweep should report the old slate, got %d", pruned)
	}
	if err := q.pool.QueryRow(ctx, `SELECT COUNT(*) FROM recommendation_slates WHERE profile_id=$1`, profileID).Scan(&slates); err != nil {
		t.Fatal(err)
	}
	if slates != 1 {
		t.Fatalf("old slate should be pruned with children; got %d", slates)
	}
	var watchEvents int
	if err := q.pool.QueryRow(ctx, `SELECT COUNT(*) FROM recommendation_watch_events WHERE profile_id=$1`, profileID).Scan(&watchEvents); err != nil {
		t.Fatal(err)
	}
	if watchEvents != 1 {
		t.Fatalf("retention should preserve only the recent watch event; got %d", watchEvents)
	}

	var survivingSlateID int64
	if err := q.pool.QueryRow(ctx, `SELECT id FROM recommendation_slates WHERE profile_id=$1`, profileID).Scan(&survivingSlateID); err != nil {
		t.Fatal(err)
	}
	if _, err := q.pool.Exec(ctx, `DELETE FROM user_profiles WHERE id=$1`, profileID); err != nil {
		t.Fatalf("delete profile: %v", err)
	}
	for table, query := range map[string]string{
		"slates":      `SELECT COUNT(*) FROM recommendation_slates WHERE id=$1`,
		"impressions": `SELECT COUNT(*) FROM recommendation_impressions WHERE slate_id=$1`,
	} {
		var n int
		if err := q.pool.QueryRow(ctx, query, survivingSlateID).Scan(&n); err != nil {
			t.Fatalf("count %s after profile cascade: %v", table, err)
		}
		if n != 0 {
			t.Fatalf("profile cascade left %d %s rows", n, table)
		}
	}
}

func TestMarkRecommendationVisible(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	itemID := seedTestMediaItem(t, q, libID)

	const token = "visibility-test-slate"
	if err := q.RecordRecommendationImpressions(ctx, profileID, "hero", token, []RecommendationImpression{{
		MediaItemID: itemID, Position: 1, Match: 70, Confidence: .6,
		ModelVersion: "test-v", Similarity: .82, Evidence: 8,
	}}); err != nil {
		t.Fatal(err)
	}
	if ok, err := q.MarkRecommendationVisible(ctx, profileID, token, itemID, 1, 1499); err != nil || ok {
		t.Fatalf("sub-threshold exposure must be rejected: ok=%v err=%v", ok, err)
	}
	if ok, err := q.MarkRecommendationVisible(ctx, profileID, token, itemID, 1, 1500); err != nil || !ok {
		t.Fatalf("mark visible: ok=%v err=%v", ok, err)
	}
	// Idempotent retry keeps the first timestamp but raises measured dwell.
	var firstAt time.Time
	if err := q.pool.QueryRow(ctx, `SELECT visible_at FROM recommendation_impressions WHERE profile_id=$1 AND media_item_id=$2`, profileID, itemID).Scan(&firstAt); err != nil {
		t.Fatal(err)
	}
	if ok, err := q.MarkRecommendationVisible(ctx, profileID, token, itemID, 1, 2200); err != nil || !ok {
		t.Fatalf("retry visible: ok=%v err=%v", ok, err)
	}
	var gotAt time.Time
	var gotMs int
	if err := q.pool.QueryRow(ctx, `SELECT visible_at, visible_ms FROM recommendation_impressions WHERE profile_id=$1 AND media_item_id=$2`, profileID, itemID).Scan(&gotAt, &gotMs); err != nil {
		t.Fatal(err)
	}
	if !gotAt.Equal(firstAt) || gotMs != 2200 {
		t.Fatalf("idempotency/dwell failed: first=%v got=%v ms=%d", firstAt, gotAt, gotMs)
	}
	if ok, err := q.MarkRecommendationVisible(ctx, profileID, "wrong-token", itemID, 1, 9999); err != nil || ok {
		t.Fatalf("wrong token must not update: ok=%v err=%v", ok, err)
	}
	if err := q.SetUserRating(ctx, profileID, itemID, 4); err != nil {
		t.Fatalf("set post-exposure rating: %v", err)
	}
	calibration, err := q.RecommendationCalibrationRows(ctx, time.Now().Add(-time.Hour), 100)
	if err != nil {
		t.Fatalf("calibration rows: %v", err)
	}
	found := false
	for _, row := range calibration {
		if row.ProfileID == profileID && row.MediaItemID == itemID {
			found = true
			if !row.Observed || row.Label != .85 || row.LabelReason != "rated_4" {
				t.Fatalf("rated exposure label = (%v,%v,%q)", row.Label, row.Observed, row.LabelReason)
			}
		}
	}
	if !found {
		t.Fatal("visible rated impression missing from calibration rows")
	}
}
