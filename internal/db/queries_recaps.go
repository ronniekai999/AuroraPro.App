package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Queries backing the "Previously" spoiler-safe recap feature (catch-me-up).
//
// The spoiler boundary is a NUMBER, not a vibe: a viewer's last completed
// episode (season, episode) ordinal. RecapEpisodesUpToBoundary returns only
// episodes at or before that ordinal, so "no spoilers" is guaranteed by the
// query — the LLM never sees anything past where the viewer is.

// RecapBoundary identifies the last episode a profile finished for a show —
// the spoiler boundary the recap is generated up to.
type RecapBoundary struct {
	EpisodeID     int64
	SeasonNumber  int
	EpisodeNumber int
	Title         string
}

// RecapEpisode is one bounded input synopsis for the recap prompt.
type RecapEpisode struct {
	SeasonNumber  int
	EpisodeNumber int
	Title         string
	Overview      string
}

// CachedRecap is a stored recap plus the validity keys (model + source_hash)
// the service compares against before serving it.
type CachedRecap struct {
	Recap      string
	Model      string
	SourceHash string
}

// LastCompletedEpisode returns the highest (season, episode) ordinal the
// profile has marked completed for the given show — the recap boundary.
// Returns pgx.ErrNoRows when the profile hasn't finished any episode (the
// caller treats that as "nothing to recap yet" and hides the affordance).
//
// Keyed off wp.episode_id joined through tv_episodes to the show, so it is
// correct regardless of what watch_progress.media_item_id holds for an
// episode row. Per-profile (migration 029) by wp.profile_id.
func (q *Queries) LastCompletedEpisode(ctx context.Context, profileID, mediaItemID int64) (*RecapBoundary, error) {
	row := q.pool.QueryRow(ctx, `
		SELECT e.id, s.season_number, e.episode_number, COALESCE(e.title, '')
		FROM watch_progress wp
		JOIN tv_episodes e ON e.id = wp.episode_id
		JOIN tv_seasons  s ON s.id = e.season_id
		WHERE wp.profile_id = $1
		  AND e.media_item_id = $2
		  AND wp.completed = TRUE
		ORDER BY s.season_number DESC, e.episode_number DESC
		LIMIT 1`,
		profileID, mediaItemID,
	)
	var b RecapBoundary
	if err := row.Scan(&b.EpisodeID, &b.SeasonNumber, &b.EpisodeNumber, &b.Title); err != nil {
		return nil, err
	}
	return &b, nil
}

// RecapEpisodesUpToBoundary returns the show's episodes at or before the
// (boundarySeason, boundaryEpisode) ordinal, in air order, with a non-empty
// overview. This is the spoiler-safe input set: everything the viewer has
// reached, nothing beyond it.
//
// The JOIN constrains s.media_item_id = e.media_item_id (not just e.media_item_id)
// for the same reason GetEpisodes does — a corrupt episode row pointing at
// another show's season can't leak in.
func (q *Queries) RecapEpisodesUpToBoundary(ctx context.Context, mediaItemID int64, boundarySeason, boundaryEpisode int) ([]RecapEpisode, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT s.season_number, e.episode_number,
		       COALESCE(e.title, ''), COALESCE(e.overview, '')
		FROM tv_episodes e
		JOIN tv_seasons  s ON s.id = e.season_id AND s.media_item_id = e.media_item_id
		WHERE e.media_item_id = $1
		  AND ( s.season_number < $2
		        OR (s.season_number = $2 AND e.episode_number <= $3) )
		  AND COALESCE(e.overview, '') <> ''
		ORDER BY s.season_number, e.episode_number`,
		mediaItemID, boundarySeason, boundaryEpisode,
	)
	if err != nil {
		return nil, fmt.Errorf("recap episodes up to boundary: %w", err)
	}
	defer rows.Close()

	var out []RecapEpisode
	for rows.Next() {
		var e RecapEpisode
		if err := rows.Scan(&e.SeasonNumber, &e.EpisodeNumber, &e.Title, &e.Overview); err != nil {
			return nil, fmt.Errorf("scan recap episode: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// HasEpisodeAfterBoundary reports whether the show has any episode after the
// (boundarySeason, boundaryEpisode) ordinal — i.e. whether the viewer has
// episodes left to watch. False means they're caught up to the latest available
// episode, which lets the recap safely give a complete, resolved summary.
func (q *Queries) HasEpisodeAfterBoundary(ctx context.Context, mediaItemID int64, boundarySeason, boundaryEpisode int) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM tv_episodes e
			JOIN tv_seasons s ON s.id = e.season_id AND s.media_item_id = e.media_item_id
			WHERE e.media_item_id = $1
			  AND ( s.season_number > $2
			        OR (s.season_number = $2 AND e.episode_number > $3) )
		)`,
		mediaItemID, boundarySeason, boundaryEpisode,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("has episode after boundary: %w", err)
	}
	return exists, nil
}

// IsLastEpisodeOfSeason reports whether (boundarySeason, boundaryEpisode) is
// the highest-numbered episode of that season present in the library — i.e.
// the viewer finished a season finale (as far as the library knows). Combined
// with HasEpisodeAfterBoundary=true this selects the recap's season-closure
// mode. Same corruption-proof JOIN shape as the other recap queries.
func (q *Queries) IsLastEpisodeOfSeason(ctx context.Context, mediaItemID int64, boundarySeason, boundaryEpisode int) (bool, error) {
	var hasLater bool
	err := q.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM tv_episodes e
			JOIN tv_seasons s ON s.id = e.season_id AND s.media_item_id = e.media_item_id
			WHERE e.media_item_id = $1
			  AND s.season_number = $2
			  AND e.episode_number > $3
		)`,
		mediaItemID, boundarySeason, boundaryEpisode,
	).Scan(&hasLater)
	if err != nil {
		return false, fmt.Errorf("is last episode of season: %w", err)
	}
	return !hasLater, nil
}

// GetCachedRecap returns the cached recap for a (show, boundary) pair, if one
// exists. ok is false (with nil error) on a cache miss.
func (q *Queries) GetCachedRecap(ctx context.Context, mediaItemID, upToEpisodeID int64) (CachedRecap, bool, error) {
	row := q.pool.QueryRow(ctx, `
		SELECT recap, model, source_hash
		FROM episode_recaps
		WHERE media_item_id = $1 AND up_to_episode_id = $2`,
		mediaItemID, upToEpisodeID,
	)
	var c CachedRecap
	if err := row.Scan(&c.Recap, &c.Model, &c.SourceHash); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CachedRecap{}, false, nil // clean cache miss
		}
		return CachedRecap{}, false, fmt.Errorf("get cached recap: %w", err)
	}
	return c, true, nil
}

// UpsertRecap stores (or replaces) the recap for a (show, boundary) pair.
func (q *Queries) UpsertRecap(ctx context.Context, mediaItemID, upToEpisodeID int64, recap, model, sourceHash string) error {
	_, err := q.pool.Exec(ctx, `
		INSERT INTO episode_recaps (media_item_id, up_to_episode_id, recap, model, source_hash)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (media_item_id, up_to_episode_id)
		DO UPDATE SET recap = EXCLUDED.recap,
		              model = EXCLUDED.model,
		              source_hash = EXCLUDED.source_hash,
		              created_at = now()`,
		mediaItemID, upToEpisodeID, recap, model, sourceHash,
	)
	if err != nil {
		return fmt.Errorf("upsert recap: %w", err)
	}
	return nil
}
