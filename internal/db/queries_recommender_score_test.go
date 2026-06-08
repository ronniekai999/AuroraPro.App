package db

import (
	"strings"
	"testing"
)

// TestScoringQueryFragments structurally smoke-tests the shared Aurora Score
// SQL fragments. These can't be executed without Postgres, so this guards the
// concatenation/shape: balanced parentheses, the heat-decay parameter is
// referenced, and the engagement aggregates point at the real tables/columns
// (verified against the migrations). A malformed fragment fails here rather
// than at runtime on the deployed server.
func TestScoringQueryFragments(t *testing.T) {
	if open, closeParen := strings.Count(scoringEngagementJoins, "("), strings.Count(scoringEngagementJoins, ")"); open != closeParen {
		t.Errorf("unbalanced parentheses in scoringEngagementJoins: %d open vs %d close", open, closeParen)
	}
	if !strings.Contains(scoringEngagementJoins, "$1") {
		t.Error("scoringEngagementJoins must reference $1 (the heat-decay scale)")
	}
	// Engagement aggregates target the verified schema.
	for _, want := range []string{
		"watch_progress", "watchlist_items", "collection_items",
		"list_type = 'favorites'", "completed_at", "position_ms", "completed",
		"wp.media_item_id = m.id", "fav.media_item_id = m.id", "col.media_item_id = m.id",
	} {
		if !strings.Contains(scoringEngagementJoins, want) {
			t.Errorf("scoringEngagementJoins missing expected fragment %q", want)
		}
	}
	// The projection must reference every join alias the scan relies on.
	for _, want := range []string{"wp.heat", "wp.starts", "wp.finishes", "fav.cnt", "col.cnt", "m.added_at"} {
		if !strings.Contains(scoringSelectCols, want) {
			t.Errorf("scoringSelectCols missing %q", want)
		}
	}
}
