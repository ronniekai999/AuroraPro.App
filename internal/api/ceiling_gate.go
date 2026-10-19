package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// The by-id ceiling gate (issue #462). A route that takes a media or episode
// id from the client checks it against a profile's ceiling before it answers,
// so a restricted profile cannot read, or write and then read back, a title
// its library listing hides just by naming the id.
//
// By-id lookups use the session's acting profile. Profile-keyed routes use
// the profile resolveRequestProfile resolved, which for a restricted session
// is always the acting profile.

// mediaHidden reports whether profile's ceiling hides mediaID. An
// unrestricted profile hides nothing and costs no lookup. Under a ceiling a
// missing title counts as hidden, so the caller's 404 reads the same for "over
// the limit" and "no such title", and a lookup error counts as hidden too.
func mediaHidden(ctx context.Context, q *db.Queries, profile *models.UserProfile, mediaID int64) (bool, error) {
	if db.AllowedRatingsForMax(profile.MaxAgeRating) == nil {
		return false, nil
	}
	item, err := q.GetMediaItem(ctx, mediaID)
	if err != nil {
		return true, err
	}
	return item == nil || !db.RatingAllowed(profile.MaxAgeRating, item.ContentRating), nil
}

// episodeHidden is mediaHidden for an episode id, judged by its show's
// rating: content_rating lives on media_items, not on episodes.
func episodeHidden(ctx context.Context, q *db.Queries, profile *models.UserProfile, episodeID int64) (bool, error) {
	if db.AllowedRatingsForMax(profile.MaxAgeRating) == nil {
		return false, nil
	}
	rating, err := q.GetContentRatingForEpisode(ctx, episodeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return true, err
	}
	return !db.RatingAllowed(profile.MaxAgeRating, rating), nil
}

// progressHidden gates a progress read or write: the title, and the episode
// when one is named. The episode is judged on its own show, so an episode id
// from an over-ceiling show filed under an allowed one is still refused.
func progressHidden(ctx context.Context, q *db.Queries, profile *models.UserProfile, mediaID int64, episodeID *int64) (bool, error) {
	if hidden, err := mediaHidden(ctx, q, profile, mediaID); err != nil || hidden {
		return true, err
	}
	if episodeID != nil {
		return episodeHidden(ctx, q, profile, *episodeID)
	}
	return false, nil
}

// actingMediaHidden is mediaHidden for the session's acting profile. It fails
// closed when the acting profile cannot be resolved.
func actingMediaHidden(ctx context.Context, q *db.Queries, claims *auth.JWTClaims, mediaID int64) (bool, error) {
	profile, err := q.ResolveActingProfile(ctx, claims.UserID, claims.RefreshTokenID)
	if err != nil {
		return true, err
	}
	return mediaHidden(ctx, q, profile, mediaID)
}

// actingEpisodeHidden is episodeHidden for the session's acting profile.
func actingEpisodeHidden(ctx context.Context, q *db.Queries, claims *auth.JWTClaims, episodeID int64) (bool, error) {
	profile, err := q.ResolveActingProfile(ctx, claims.UserID, claims.RefreshTokenID)
	if err != nil {
		return true, err
	}
	return episodeHidden(ctx, q, profile, episodeID)
}

// denyHiddenMedia writes the gate's refusal, the 404 a missing title gets.
func denyHiddenMedia(w http.ResponseWriter, id int64, err error) {
	if err != nil {
		slog.Error("rating ceiling check failed, denying by default", "id", id, "error", err)
	}
	writeError(w, http.StatusNotFound, "media not found")
}
