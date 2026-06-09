package db

// Integration tests for the Phase C engagement-rail queries. Opt-in via
// TEST_DATABASE_URL (skipped otherwise), mirroring queries_surfaced_test.go.
// These pin the load-bearing filters: unwatched-exclusion, the rating/runtime/
// vote gates, profile scoping, and that Trending requires real recent heat.

import (
	"context"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

func resultIDs(items []*models.MediaItem) map[int64]bool {
	m := make(map[int64]bool, len(items))
	for _, it := range items {
		m[it.ID] = true
	}
	return m
}

func seedRailItem(t *testing.T, q *Queries, libID int64, typ string, rating float64, votes, runtime int) int64 {
	t.Helper()
	var id int64
	if err := q.pool.QueryRow(context.Background(),
		`INSERT INTO media_items (library_id, type, title, sort_title, rating, vote_count, runtime_minutes, backdrop_path)
		 VALUES ($1, $2, $3, $3, $4, $5, $6, '/bd.jpg') RETURNING id`,
		libID, typ, "Rail "+randomSuffix(t), rating, votes, runtime).Scan(&id); err != nil {
		t.Fatalf("seed rail item: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(context.Background(), `DELETE FROM media_items WHERE id=$1`, id) })
	return id
}

func seedExtraProfile(t *testing.T, q *Queries, userID int64) int64 {
	t.Helper()
	var id int64
	if err := q.pool.QueryRow(context.Background(),
		`INSERT INTO user_profiles (user_id, name, is_default) VALUES ($1, $2, FALSE) RETURNING id`,
		userID, "extra_"+randomSuffix(t)).Scan(&id); err != nil {
		t.Fatalf("seed extra profile: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(context.Background(), `DELETE FROM user_profiles WHERE id=$1`, id) })
	return id
}

// play inserts one watch_progress row (started, optionally completed) aged
// ageDays into the past, for a (user, profile, item).
func play(t *testing.T, q *Queries, userID, profileID, itemID int64, completed bool, ageDays int) {
	t.Helper()
	ts := time.Now().Add(-time.Duration(ageDays) * 24 * time.Hour)
	var completedAt interface{}
	if completed {
		completedAt = ts
	}
	if _, err := q.pool.Exec(context.Background(),
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed, completed_at, updated_at)
		 VALUES ($1, $2, $3, 5000, 6000, $4, $5, $6)`,
		userID, profileID, itemID, completed, completedAt, ts); err != nil {
		t.Fatalf("play: %v", err)
	}
}

func TestHiddenGems(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	gem := seedRailItem(t, q, libID, "movie", 8.2, 500, 120)      // high rating, trusted, unwatched
	lowRated := seedRailItem(t, q, libID, "movie", 5.0, 500, 120) // below minRating → excluded
	fewVotes := seedRailItem(t, q, libID, "movie", 9.5, 3, 120)   // great score, untrusted → excluded
	watched := seedRailItem(t, q, libID, "movie", 8.8, 800, 120)  // high but already watched → excluded
	play(t, q, userID, profileID, watched, true, 1)

	out, err := q.HiddenGems(ctx, profileID, nil, 7.0, 50, 3, 20)
	if err != nil {
		t.Fatalf("hidden gems: %v", err)
	}
	got := resultIDs(out)
	if !got[gem] {
		t.Errorf("high-rated trusted unwatched gem should appear")
	}
	for name, id := range map[string]int64{"low-rated": lowRated, "few-votes": fewVotes, "watched": watched} {
		if got[id] {
			t.Errorf("%s item should be excluded from Hidden Gems", name)
		}
	}
}

func TestFinishTonightShortMovies(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	short := seedRailItem(t, q, libID, "movie", 7.5, 100, 95)    // fits → included
	long := seedRailItem(t, q, libID, "movie", 8.0, 100, 190)    // too long → excluded
	shortShow := seedRailItem(t, q, libID, "show", 8.0, 100, 45) // not a movie → excluded
	watchedShort := seedRailItem(t, q, libID, "movie", 7.0, 100, 95)
	play(t, q, userID, profileID, watchedShort, false, 1)

	out, err := q.FinishTonightShortMovies(ctx, profileID, nil, 30, 110, 20)
	if err != nil {
		t.Fatalf("finish tonight: %v", err)
	}
	got := resultIDs(out)
	if !got[short] {
		t.Errorf("short unwatched movie should appear")
	}
	for name, id := range map[string]int64{"long": long, "show": shortShow, "watched": watchedShort} {
		if got[id] {
			t.Errorf("%s should be excluded from Finish It Tonight", name)
		}
	}
}

func TestComfortRewatch(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	other := seedExtraProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	finished := seedRailItem(t, q, libID, "movie", 7.0, 100, 100)
	inProgress := seedRailItem(t, q, libID, "movie", 7.0, 100, 100)
	otherProfile := seedRailItem(t, q, libID, "movie", 7.0, 100, 100)
	play(t, q, userID, profileID, finished, true, 2)
	play(t, q, userID, profileID, inProgress, false, 1) // not completed → excluded
	play(t, q, userID, other, otherProfile, true, 1)    // completed by a DIFFERENT profile → excluded

	out, err := q.ComfortRewatch(ctx, profileID, nil, 20)
	if err != nil {
		t.Fatalf("comfort rewatch: %v", err)
	}
	got := resultIDs(out)
	if !got[finished] {
		t.Errorf("completed item should appear in Comfort Rewatch")
	}
	if got[inProgress] {
		t.Errorf("in-progress (not completed) item should be excluded")
	}
	if got[otherProfile] {
		t.Errorf("item completed by another profile must not leak in (profile scoping)")
	}
}

// TestComfortRewatchShowCollapse exercises the DISTINCT ON (m.id) collapse: a
// show with several completed episodes (distinct watch_progress rows under one
// show media_item_id) must appear as exactly ONE card, not one per episode.
func TestComfortRewatchShowCollapse(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	show := seedRailItem(t, q, libID, "show", 8.0, 100, 0)
	eps := seedShowWithEpisodes(t, q, show, 3)
	for _, epID := range eps[:2] { // complete two episodes of the same show
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO watch_progress (user_id, profile_id, media_item_id, episode_id, position_ms, duration_ms, completed, completed_at, updated_at)
			 VALUES ($1, $2, $3, $4, 6000, 6000, TRUE, now(), now())`,
			userID, profileID, show, epID); err != nil {
			t.Fatalf("complete episode: %v", err)
		}
	}

	out, err := q.ComfortRewatch(ctx, profileID, nil, 20)
	if err != nil {
		t.Fatalf("comfort rewatch: %v", err)
	}
	count := 0
	for _, it := range out {
		if it.ID == show {
			count++
		}
	}
	if count != 1 {
		t.Errorf("DISTINCT ON should collapse a show's completed episodes to ONE card, got %d", count)
	}
}

func TestTrendingUnwatched(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	p2 := seedExtraProfile(t, q, userID)
	p3 := seedExtraProfile(t, q, userID)
	p4 := seedExtraProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	hot := seedRailItem(t, q, libID, "movie", 7.0, 100, 100) // 3 recent plays (other profiles) → trends
	play(t, q, userID, p2, hot, true, 1)
	play(t, q, userID, p3, hot, true, 2)
	play(t, q, userID, p4, hot, false, 3)

	cold := seedRailItem(t, q, libID, "movie", 7.0, 100, 100) // only 1 play → below minStarts
	play(t, q, userID, p2, cold, true, 1)

	watchedHot := seedRailItem(t, q, libID, "movie", 7.0, 100, 100) // hot but THIS profile watched → excluded
	play(t, q, userID, p2, watchedHot, true, 1)
	play(t, q, userID, p3, watchedHot, true, 1)
	play(t, q, userID, profileID, watchedHot, true, 1)

	out, err := q.TrendingUnwatched(ctx, profileID, nil, 10.0, 30, 3, 20)
	if err != nil {
		t.Fatalf("trending: %v", err)
	}
	got := resultIDs(out)
	if !got[hot] {
		t.Errorf("item with >= minStarts recent plays should trend")
	}
	if got[cold] {
		t.Errorf("item below minStarts should not trend")
	}
	if got[watchedHot] {
		t.Errorf("a hot item this profile already watched must be excluded")
	}
}
