package db

// Integration tests for MatchEvidenceCount — the evidence term the personal
// Match formula shrinks toward its 0.50 prior with (rho = n/(n+5)). Opt-in via
// TEST_DATABASE_URL, like the rest of internal/db.
//
// These are SQL-shaped guarantees: "uncapped" and "distinct titles" are the two
// properties that separate this from PersonalizationHistoryCount, and both are
// invisible to a Go unit test.

import (
	"context"
	"testing"
)

// The taste slice is capped at 20 because CLUSTERING wants a recent slice.
// Reused as evidence that cap pinned rho at 20/25 = 0.8 forever, so no profile
// could ever be shown a Match above ~86%. Evidence must keep accruing.
func TestMatchEvidenceCount_IsNotCappedByTheTasteSlice(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	const titles = 25 // past the slice's LIMIT 20
	for i := 0; i < titles; i++ {
		item := seedEmbeddedItem(t, q, libID, i%8)
		setProgress(t, q, userID, profileID, item, 100, 100, true)
	}

	sliceCount, err := q.PersonalizationHistoryCount(ctx, profileID)
	if err != nil {
		t.Fatalf("history count: %v", err)
	}
	if sliceCount != 20 {
		t.Fatalf("taste slice = %d, want the capped 20 (the UI hint keeps this)", sliceCount)
	}

	evidence, err := q.MatchEvidenceCount(ctx, profileID)
	if err != nil {
		t.Fatalf("evidence count: %v", err)
	}
	if evidence != titles {
		t.Fatalf("evidence = %d, want %d — the slice's LIMIT must not bound it", evidence, titles)
	}
}

// watch_progress holds one row PER EPISODE, so counting rows let a single
// binged show read as a mature, many-title profile's worth of independent
// evidence. One show is one opinion.
func TestMatchEvidenceCount_CountsDistinctTitlesNotEpisodeRows(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	showID := seedEmbeddedItem(t, q, libID, 0)
	for _, epID := range seedShowWithEpisodes(t, q, showID, 12) {
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO watch_progress (user_id, profile_id, media_item_id, episode_id, position_ms, duration_ms, completed)
			 VALUES ($1, $2, $3, $4, 1000, 1000, true)`,
			userID, profileID, showID, epID); err != nil {
			t.Fatalf("seed episode progress: %v", err)
		}
	}

	evidence, err := q.MatchEvidenceCount(ctx, profileID)
	if err != nil {
		t.Fatalf("evidence count: %v", err)
	}
	if evidence != 1 {
		t.Fatalf("a 12-episode binge = %d evidence, want 1 (one title, one opinion)", evidence)
	}

	// A second, different title is a second opinion.
	setProgress(t, q, userID, profileID, seedEmbeddedItem(t, q, libID, 1), 100, 100, true)
	if evidence, err = q.MatchEvidenceCount(ctx, profileID); err != nil || evidence != 2 {
		t.Fatalf("evidence after a second title = %d (err %v), want 2", evidence, err)
	}
}

// Evidence shares its source branches with the centroid slice, so a title the
// profile rated 1-2★ must not prop up confidence in a taste model it is
// excluded from steering.
func TestMatchEvidenceCount_ExcludesLowRatedTitles(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	kept := seedEmbeddedItem(t, q, libID, 0)
	hated := seedEmbeddedItem(t, q, libID, 1)
	setProgress(t, q, userID, profileID, kept, 100, 100, true)
	setProgress(t, q, userID, profileID, hated, 100, 100, true)
	if err := q.SetUserRating(ctx, profileID, hated, 1); err != nil {
		t.Fatalf("set rating: %v", err)
	}

	evidence, err := q.MatchEvidenceCount(ctx, profileID)
	if err != nil {
		t.Fatalf("evidence count: %v", err)
	}
	if evidence != 1 {
		t.Fatalf("evidence = %d, want 1 — a 1★ title must not count as support", evidence)
	}
}

// A profile with no signals has no evidence, which is what suppresses the
// personal Match entirely (applyPersonalMatch returns early at 0).
func TestMatchEvidenceCount_ColdProfileIsZero(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)

	evidence, err := q.MatchEvidenceCount(context.Background(), profileID)
	if err != nil {
		t.Fatalf("evidence count: %v", err)
	}
	if evidence != 0 {
		t.Fatalf("cold profile evidence = %d, want 0", evidence)
	}
}
