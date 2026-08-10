package db

// Integration tests for issue #462's server-authoritative acting-profile
// mechanism: ResolveActingProfile / SetActiveProfileForToken (the
// refresh_tokens.active_profile_id binding) and the content-rating lookups
// the read/playback path gates on. Opt-in via TEST_DATABASE_URL, same
// harness as the other db-package integration tests.

import (
	"context"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// seedRefreshToken inserts a minimal refresh_tokens row and returns its id,
// so tests can exercise ResolveActingProfile/SetActiveProfileForToken
// without going through the full auth HTTP flow.
func seedRefreshToken(t *testing.T, q *Queries, userID int64) int64 {
	t.Helper()
	rt := &models.RefreshToken{
		UserID:    userID,
		Token:     "rating-ceiling-test-token",
		ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := q.CreateRefreshToken(context.Background(), rt); err != nil {
		t.Fatalf("seed refresh token: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM refresh_tokens WHERE id = $1`, rt.ID)
	})
	return rt.ID
}

func TestResolveActingProfile(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	defaultProfileID := seedDefaultProfile(t, q, userID)

	kid := &models.UserProfile{UserID: userID, Name: "kid", MaxAgeRating: "PG", Language: "en", SubtitleMode: "off"}
	if err := q.CreateProfile(ctx, kid); err != nil {
		t.Fatalf("create second profile: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM user_profiles WHERE id = $1`, kid.ID) })

	// No refresh-token session at all (refreshTokenID=0, e.g. a cast token
	// or a pre-migration access token) → falls back to the account default,
	// exactly like the pre-#462 "no profile signal" behavior everywhere else.
	got, err := q.ResolveActingProfile(ctx, userID, 0)
	if err != nil {
		t.Fatalf("resolve (no session): %v", err)
	}
	if got == nil || got.ID != defaultProfileID {
		t.Fatalf("resolve (no session) = %+v, want default profile %d", got, defaultProfileID)
	}

	// A session that exists but never explicitly activated a profile →
	// still the default (active_profile_id is NULL).
	rtID := seedRefreshToken(t, q, userID)
	got, err = q.ResolveActingProfile(ctx, userID, rtID)
	if err != nil {
		t.Fatalf("resolve (unset binding): %v", err)
	}
	if got == nil || got.ID != defaultProfileID {
		t.Fatalf("resolve (unset binding) = %+v, want default profile %d", got, defaultProfileID)
	}

	// Bind the session to the kid profile — this is the mechanism issue
	// #462 relies on to make enforcement server-authoritative.
	ok, err := q.SetActiveProfileForToken(ctx, rtID, userID, kid.ID)
	if err != nil {
		t.Fatalf("set active profile: %v", err)
	}
	if !ok {
		t.Fatal("SetActiveProfileForToken returned ok=false for a valid, owned binding")
	}
	got, err = q.ResolveActingProfile(ctx, userID, rtID)
	if err != nil {
		t.Fatalf("resolve (bound): %v", err)
	}
	if got == nil || got.ID != kid.ID {
		t.Fatalf("resolve (bound) = %+v, want kid profile %d", got, kid.ID)
	}

	// Cross-account: a refresh token that belongs to a DIFFERENT user must
	// not let userID's lookup succeed against it — the ownership check in
	// SetActiveProfileForToken's WHERE clause is the guard here.
	otherUser := seedTestUser(t, q)
	ok, err = q.SetActiveProfileForToken(ctx, rtID, otherUser, kid.ID)
	if err != nil {
		t.Fatalf("set active profile (wrong user): %v", err)
	}
	if ok {
		t.Fatal("SetActiveProfileForToken succeeded against a refresh token owned by a different user")
	}

	// A profile id that exists but belongs to someone else must not be
	// resolved even if it somehow ended up referenced — ResolveActingProfile
	// re-validates ownership independently of SetActiveProfileForToken's own
	// check, so a stale/foreign binding can't leak another account's ceiling.
	otherProfileID := seedDefaultProfile(t, q, otherUser)
	if _, err := q.pool.Exec(ctx, `UPDATE refresh_tokens SET active_profile_id = $1 WHERE id = $2`, otherProfileID, rtID); err != nil {
		t.Fatalf("force cross-account binding: %v", err)
	}
	got, err = q.ResolveActingProfile(ctx, userID, rtID)
	if err != nil {
		t.Fatalf("resolve (cross-account binding): %v", err)
	}
	if got == nil || got.ID != defaultProfileID {
		t.Fatalf("resolve (cross-account binding) = %+v, want fallback to default profile %d (not the foreign profile)", got, defaultProfileID)
	}
}

func TestGetContentRatingForFile(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, userID)

	// Movie file.
	movieID := seedTestMediaItem(t, q, libID)
	if _, err := q.pool.Exec(ctx, `UPDATE media_items SET content_rating = 'R' WHERE id = $1`, movieID); err != nil {
		t.Fatalf("set movie rating: %v", err)
	}
	var mediaFileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO media_files (media_item_id, path, file_hash) VALUES ($1, $2, 'h') RETURNING id`,
		movieID, "/media/"+time.Now().String()).Scan(&mediaFileID); err != nil {
		t.Fatalf("seed media file: %v", err)
	}
	rating, err := q.GetContentRatingForMediaFile(ctx, mediaFileID)
	if err != nil {
		t.Fatalf("GetContentRatingForMediaFile: %v", err)
	}
	if rating != "R" {
		t.Errorf("GetContentRatingForMediaFile = %q, want %q", rating, "R")
	}

	// Show/episode file — content_rating lives on the SHOW's media_items
	// row, not per-episode, so the join through tv_episodes must resolve it.
	showID := seedTestMediaItem(t, q, libID)
	if _, err := q.pool.Exec(ctx, `UPDATE media_items SET content_rating = 'TV-MA', type = 'show' WHERE id = $1`, showID); err != nil {
		t.Fatalf("set show rating: %v", err)
	}
	var seasonID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1, 1) RETURNING id`, showID).Scan(&seasonID); err != nil {
		t.Fatalf("seed season: %v", err)
	}
	var episodeID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_episodes (media_item_id, season_id, episode_number, title) VALUES ($1, $2, 1, 'e1') RETURNING id`,
		showID, seasonID).Scan(&episodeID); err != nil {
		t.Fatalf("seed episode: %v", err)
	}
	var episodeFileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO episode_files (episode_id, path, file_hash) VALUES ($1, $2, 'h') RETURNING id`,
		episodeID, "/media/"+time.Now().String()).Scan(&episodeFileID); err != nil {
		t.Fatalf("seed episode file: %v", err)
	}
	rating, err = q.GetContentRatingForEpisodeFile(ctx, episodeFileID)
	if err != nil {
		t.Fatalf("GetContentRatingForEpisodeFile: %v", err)
	}
	if rating != "TV-MA" {
		t.Errorf("GetContentRatingForEpisodeFile = %q, want %q", rating, "TV-MA")
	}

	// Unrated: content_rating defaults to NULL — must come back as "", which
	// RatingAllowed treats as excluded under any restriction (fail-closed).
	unratedID := seedTestMediaItem(t, q, libID)
	var unratedFileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO media_files (media_item_id, path, file_hash) VALUES ($1, $2, 'h') RETURNING id`,
		unratedID, "/media/"+time.Now().String()).Scan(&unratedFileID); err != nil {
		t.Fatalf("seed unrated media file: %v", err)
	}
	rating, err = q.GetContentRatingForMediaFile(ctx, unratedFileID)
	if err != nil {
		t.Fatalf("GetContentRatingForMediaFile (unrated): %v", err)
	}
	if rating != "" {
		t.Errorf("GetContentRatingForMediaFile (unrated) = %q, want empty string", rating)
	}
}
