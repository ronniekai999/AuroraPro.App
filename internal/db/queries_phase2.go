package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ============================================================
// Metadata Updates
// ============================================================

// DuplicateMetadataError is returned when UpdateMediaMetadata would violate a
// unique constraint (e.g., another media item already has the same TMDB ID or
// the same library+type+title+year combination). The CanonicalID field contains
// the ID of the existing media item that owns the conflicting key.
type DuplicateMetadataError struct {
	Constraint  string // constraint name (e.g., "idx_media_items_tmdb")
	CanonicalID int64  // ID of the existing media item, or 0 if unknown
	DuplicateID int64  // ID of the item that was being updated
}

func (e *DuplicateMetadataError) Error() string {
	return fmt.Sprintf("duplicate metadata: constraint %s, canonical=%d, duplicate=%d",
		e.Constraint, e.CanonicalID, e.DuplicateID)
}

// IsDuplicateMetadata returns true if err is a *DuplicateMetadataError.
func IsDuplicateMetadata(err error) bool {
	var dme *DuplicateMetadataError
	return errors.As(err, &dme)
}

// AsDuplicateMetadata extracts the *DuplicateMetadataError from err, if present.
func AsDuplicateMetadata(err error) (*DuplicateMetadataError, bool) {
	var dme *DuplicateMetadataError
	if errors.As(err, &dme) {
		return dme, true
	}
	return nil, false
}

// UpdateMediaMetadata applies a partial update to media_items from TMDB data.
// Only non-nil fields in the update struct are written.
//
// If the update would violate a unique constraint (uq_media_items_lib_type_title_year),
// or if it creates a same-library TMDB ID duplicate (detected at application level since
// idx_media_items_tmdb is no longer UNIQUE per migration 011), a *DuplicateMetadataError
// is returned. The caller (enricher) can then merge the duplicate into the canonical one.
func (q *Queries) UpdateMediaMetadata(ctx context.Context, u *models.MetadataUpdate) error {
	setClauses := []string{}
	args := []interface{}{}
	idx := 1

	addField := func(col string, val interface{}) {
		setClauses = append(setClauses, fmt.Sprintf("%s = $%d", col, idx))
		args = append(args, val)
		idx++
	}

	if u.TMDBID != nil {
		addField("tmdb_id", *u.TMDBID)
	}
	if u.IMDbID != nil {
		addField("imdb_id", *u.IMDbID)
	}
	if u.Title != nil {
		addField("title", *u.Title)
	}
	if u.Overview != nil {
		addField("overview", *u.Overview)
	}
	if u.Tagline != nil {
		addField("tagline", *u.Tagline)
	}
	if u.Status != nil {
		addField("status", *u.Status)
	}
	if u.OriginalLang != nil {
		addField("original_lang", *u.OriginalLang)
	}
	if u.ContentRating != nil {
		addField("content_rating", *u.ContentRating)
	}
	if u.PosterPath != nil {
		addField("poster_path", *u.PosterPath)
	}
	if u.BackdropPath != nil {
		addField("backdrop_path", *u.BackdropPath)
	}
	if u.Popularity != nil {
		addField("popularity", *u.Popularity)
	}
	if u.VoteAverage != nil {
		addField("rating", *u.VoteAverage)
	}
	if u.VoteCount != nil {
		addField("vote_count", *u.VoteCount)
	}
	if u.RuntimeMin != nil {
		addField("runtime_minutes", *u.RuntimeMin)
	}
	if u.Year != nil {
		addField("year", *u.Year)
	}
	if u.SortTitle != nil {
		addField("sort_title", *u.SortTitle)
	}
	if u.MetadataSrc != nil {
		addField("metadata_src", *u.MetadataSrc)
	}

	// Always update last_metadata timestamp
	addField("last_metadata", time.Now())

	if len(setClauses) == 0 {
		return nil
	}

	query := fmt.Sprintf("UPDATE media_items SET %s WHERE id = $%d",
		strings.Join(setClauses, ", "), idx)
	args = append(args, u.MediaItemID)

	_, err := q.pool.Exec(ctx, query, args...)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// Unique constraint violation — find the existing canonical item.
			canonicalID := q.findCanonicalItem(ctx, u, pgErr.ConstraintName)
			return &DuplicateMetadataError{
				Constraint:  pgErr.ConstraintName,
				CanonicalID: canonicalID,
				DuplicateID: u.MediaItemID,
			}
		}
		return err
	}

	// Same-library TMDB duplicate check: idx_media_items_tmdb is no longer UNIQUE
	// (migration 011 allows cross-library items to share tmdb_id), so we manually
	// detect same-library duplicates that should be merged (e.g., "The Avengers" and
	// "Avengers" in the same library both resolving to TMDB 24428).
	if u.TMDBID != nil && *u.TMDBID > 0 {
		var canonicalID int64
		err := q.pool.QueryRow(ctx,
			`SELECT mi2.id FROM media_items mi1
			 JOIN media_items mi2 ON mi2.tmdb_id = mi1.tmdb_id
			   AND mi2.library_id = mi1.library_id AND mi2.id != mi1.id
			 WHERE mi1.id = $1 AND mi1.tmdb_id = $2
			 ORDER BY mi2.id ASC LIMIT 1`,
			u.MediaItemID, *u.TMDBID,
		).Scan(&canonicalID)
		if err == nil && canonicalID > 0 {
			return &DuplicateMetadataError{
				Constraint:  "same_library_tmdb_id",
				CanonicalID: canonicalID,
				DuplicateID: u.MediaItemID,
			}
		}
	}

	return nil
}

// findCanonicalItem looks up the media item that already owns the conflicting
// unique key so the caller can merge into it.
// Note: idx_media_items_tmdb is no longer UNIQUE (migration 011 for cross-library linking),
// so 23505 violations on it won't occur. The remaining constraint is uq_media_items_lib_type_title_year.
func (q *Queries) findCanonicalItem(ctx context.Context, u *models.MetadataUpdate, constraint string) int64 {
	var canonicalID int64

	switch constraint {
	case "uq_media_items_lib_type_title_year":
		// Another item already has this library+type+title+year.
		// We need the library_id and type from the item being updated.
		var libID int64
		var itemType string
		_ = q.pool.QueryRow(ctx,
			`SELECT library_id, type FROM media_items WHERE id = $1`,
			u.MediaItemID,
		).Scan(&libID, &itemType)

		if libID > 0 {
			title := ""
			if u.Title != nil {
				title = *u.Title
			}
			year := 0
			if u.Year != nil {
				year = *u.Year
			}
			_ = q.pool.QueryRow(ctx,
				`SELECT id FROM media_items
				 WHERE library_id = $1 AND type = $2 AND title = $3
				   AND COALESCE(year, 0) = $4 AND id != $5`,
				libID, itemType, title, year, u.MediaItemID,
			).Scan(&canonicalID)
		}
	}

	return canonicalID
}

// MergeMediaItems reassigns all child records (media_files, tv_seasons,
// tv_episodes, episode_files, artwork, media_cast, media_genres, external_ids,
// watch_progress) from duplicateID to canonicalID, then deletes the duplicate.
// This is used when enrichment discovers that two separately-created media items
// actually represent the same movie or show.
func (q *Queries) MergeMediaItems(ctx context.Context, canonicalID, duplicateID int64) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin merge tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Reassign media_files (movies)
	_, err = tx.Exec(ctx,
		`UPDATE media_files SET media_item_id = $1 WHERE media_item_id = $2`,
		canonicalID, duplicateID)
	if err != nil {
		return fmt.Errorf("merge media_files: %w", err)
	}

	// For TV shows: reassign seasons. Episodes and episode_files cascade
	// through the season's media_item_id FK, but we also need to handle
	// duplicate season numbers. Use ON CONFLICT-style logic:
	// - For each season on the duplicate, if canonical already has that
	//   season number, reassign the episodes to the canonical season,
	//   then delete the duplicate season.
	// - Otherwise, reassign the season to the canonical item.
	rows, err := tx.Query(ctx,
		`SELECT id, season_number FROM tv_seasons WHERE media_item_id = $1 ORDER BY season_number`,
		duplicateID)
	if err != nil {
		return fmt.Errorf("query dup seasons: %w", err)
	}
	type seasonInfo struct {
		id     int64
		number int
	}
	var dupSeasons []seasonInfo
	for rows.Next() {
		var s seasonInfo
		if err := rows.Scan(&s.id, &s.number); err != nil {
			rows.Close()
			return fmt.Errorf("scan dup season: %w", err)
		}
		dupSeasons = append(dupSeasons, s)
	}
	rows.Close()

	for _, ds := range dupSeasons {
		// Check if canonical already has this season number.
		var canonSeasonID int64
		err := tx.QueryRow(ctx,
			`SELECT id FROM tv_seasons WHERE media_item_id = $1 AND season_number = $2`,
			canonicalID, ds.number,
		).Scan(&canonSeasonID)

		if err == nil {
			// Canonical has this season — reassign episodes, handling dups.
			// For each episode in the dup season, check if canonical season
			// already has that episode number. If so, reassign episode_files
			// and delete the dup episode. Otherwise, reassign the episode.
			epRows, err := tx.Query(ctx,
				`SELECT id, episode_number FROM tv_episodes WHERE season_id = $1`,
				ds.id)
			if err != nil {
				return fmt.Errorf("query dup episodes: %w", err)
			}
			type epInfo struct {
				id     int64
				number int
			}
			var dupEps []epInfo
			for epRows.Next() {
				var e epInfo
				if err := epRows.Scan(&e.id, &e.number); err != nil {
					epRows.Close()
					return fmt.Errorf("scan dup episode: %w", err)
				}
				dupEps = append(dupEps, e)
			}
			epRows.Close()

			for _, de := range dupEps {
				var canonEpID int64
				epErr := tx.QueryRow(ctx,
					`SELECT id FROM tv_episodes WHERE season_id = $1 AND episode_number = $2`,
					canonSeasonID, de.number,
				).Scan(&canonEpID)

				if epErr == nil {
					// Episode exists in canonical — move files, delete dup episode.
					_, err = tx.Exec(ctx,
						`UPDATE episode_files SET episode_id = $1 WHERE episode_id = $2`,
						canonEpID, de.id)
					if err != nil {
						return fmt.Errorf("merge episode_files: %w", err)
					}
					// Move watch_progress for this episode
					_, _ = tx.Exec(ctx,
						`UPDATE watch_progress SET episode_id = $1, media_item_id = $2
						 WHERE episode_id = $3
						 AND NOT EXISTS (
						   SELECT 1 FROM watch_progress wp2
						   WHERE wp2.user_id = watch_progress.user_id AND wp2.episode_id = $1
						 )`,
						canonEpID, canonicalID, de.id)
					// Delete any remaining dup watch_progress (conflict cases)
					_, _ = tx.Exec(ctx,
						`DELETE FROM watch_progress WHERE episode_id = $1`, de.id)
					// Delete the duplicate episode
					_, err = tx.Exec(ctx, `DELETE FROM tv_episodes WHERE id = $1`, de.id)
					if err != nil {
						return fmt.Errorf("delete dup episode: %w", err)
					}
				} else {
					// Episode doesn't exist in canonical — reassign it.
					_, err = tx.Exec(ctx,
						`UPDATE tv_episodes SET season_id = $1, media_item_id = $2 WHERE id = $3`,
						canonSeasonID, canonicalID, de.id)
					if err != nil {
						return fmt.Errorf("reassign episode: %w", err)
					}
					// Update watch_progress.media_item_id for this episode so
					// rows aren't orphaned when the duplicate is deleted (the
					// FK CASCADE on media_item_id would silently delete them).
					_, _ = tx.Exec(ctx,
						`UPDATE watch_progress SET media_item_id = $1 WHERE episode_id = $2`,
						canonicalID, de.id)
				}
			}

			// Delete the now-empty duplicate season.
			_, err = tx.Exec(ctx, `DELETE FROM tv_seasons WHERE id = $1`, ds.id)
			if err != nil {
				return fmt.Errorf("delete dup season: %w", err)
			}
		} else {
			// Canonical doesn't have this season — reassign it.
			_, err = tx.Exec(ctx,
				`UPDATE tv_seasons SET media_item_id = $1 WHERE id = $2`,
				canonicalID, ds.id)
			if err != nil {
				return fmt.Errorf("reassign season: %w", err)
			}
			// Also update media_item_id on the episodes under this season.
			_, err = tx.Exec(ctx,
				`UPDATE tv_episodes SET media_item_id = $1 WHERE season_id = $2`,
				canonicalID, ds.id)
			if err != nil {
				return fmt.Errorf("reassign season episodes: %w", err)
			}
			// Update watch_progress.media_item_id for all episodes in this
			// season so rows survive the duplicate media_item deletion.
			_, _ = tx.Exec(ctx,
				`UPDATE watch_progress SET media_item_id = $1
				 WHERE media_item_id = $2
				   AND episode_id IN (SELECT id FROM tv_episodes WHERE season_id = $3)`,
				canonicalID, duplicateID, ds.id)
		}
	}

	// Reassign watch_progress for the media item (non-episode entries)
	_, _ = tx.Exec(ctx,
		`UPDATE watch_progress SET media_item_id = $1
		 WHERE media_item_id = $2 AND episode_id IS NULL
		 AND NOT EXISTS (
		   SELECT 1 FROM watch_progress wp2
		   WHERE wp2.user_id = watch_progress.user_id AND wp2.media_item_id = $1 AND wp2.episode_id IS NULL
		 )`,
		canonicalID, duplicateID)
	// Delete any remaining dup watch_progress
	_, _ = tx.Exec(ctx,
		`DELETE FROM watch_progress WHERE media_item_id = $1`, duplicateID)

	// Reassign artwork (skip duplicates via ON CONFLICT-like check)
	_, _ = tx.Exec(ctx,
		`UPDATE artwork SET media_item_id = $1
		 WHERE media_item_id = $2
		 AND NOT EXISTS (
		   SELECT 1 FROM artwork a2
		   WHERE a2.media_item_id = $1 AND a2.art_type = artwork.art_type
		     AND a2.source = artwork.source AND a2.remote_path = artwork.remote_path
		 )`,
		canonicalID, duplicateID)
	_, _ = tx.Exec(ctx,
		`DELETE FROM artwork WHERE media_item_id = $1`, duplicateID)

	// Reassign media_cast (skip duplicates)
	_, _ = tx.Exec(ctx,
		`UPDATE media_cast SET media_item_id = $1
		 WHERE media_item_id = $2
		 AND NOT EXISTS (
		   SELECT 1 FROM media_cast mc2
		   WHERE mc2.media_item_id = $1 AND mc2.person_id = media_cast.person_id
		     AND mc2.role_type = media_cast.role_type AND mc2.character = media_cast.character
		 )`,
		canonicalID, duplicateID)
	_, _ = tx.Exec(ctx,
		`DELETE FROM media_cast WHERE media_item_id = $1`, duplicateID)

	// Reassign media_genres (skip duplicates)
	_, _ = tx.Exec(ctx,
		`INSERT INTO media_genres (media_item_id, genre_id)
		 SELECT $1, genre_id FROM media_genres WHERE media_item_id = $2
		 ON CONFLICT DO NOTHING`,
		canonicalID, duplicateID)
	_, _ = tx.Exec(ctx,
		`DELETE FROM media_genres WHERE media_item_id = $1`, duplicateID)

	// Reassign external_ids (skip duplicates)
	_, _ = tx.Exec(ctx,
		`INSERT INTO external_ids (media_item_id, provider, external_id)
		 SELECT $1, provider, external_id FROM external_ids WHERE media_item_id = $2
		 ON CONFLICT (media_item_id, provider) DO NOTHING`,
		canonicalID, duplicateID)
	_, _ = tx.Exec(ctx,
		`DELETE FROM external_ids WHERE media_item_id = $1`, duplicateID)

	// Finally, delete the duplicate media item.
	_, err = tx.Exec(ctx, `DELETE FROM media_items WHERE id = $1`, duplicateID)
	if err != nil {
		return fmt.Errorf("delete dup media item: %w", err)
	}

	return tx.Commit(ctx)
}

// HasTMDBMetadata checks whether a media item already has TMDB metadata populated.
// Available for callers that need a DB-level check; the scanner uses an in-memory
// sync.Map for per-scan dedup instead (to avoid blocking RefreshStaleMetadata).
func (q *Queries) HasTMDBMetadata(ctx context.Context, itemID int64) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx,
		`SELECT tmdb_id IS NOT NULL FROM media_items WHERE id = $1`, itemID,
	).Scan(&exists)
	if err != nil {
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return false, err
	}
	return exists, nil
}

// UpdateEpisodeMetadata patches a tv_episode from TMDB data.
// Matches by media_item_id + season_number + episode_number.
func (q *Queries) UpdateEpisodeMetadata(ctx context.Context, u *models.EpisodeMetadataUpdate) error {
	setClauses := []string{}
	args := []interface{}{}
	idx := 1

	addField := func(col string, val interface{}) {
		setClauses = append(setClauses, fmt.Sprintf("%s = $%d", col, idx))
		args = append(args, val)
		idx++
	}

	if u.TMDBID != nil {
		addField("tmdb_id", *u.TMDBID)
	}
	if u.Title != nil {
		addField("title", *u.Title)
	}
	if u.Overview != nil {
		addField("overview", *u.Overview)
	}
	if u.StillPath != nil {
		addField("still_path", *u.StillPath)
	}
	if u.VoteAverage != nil {
		addField("vote_average", *u.VoteAverage)
	}
	if u.VoteCount != nil {
		addField("vote_count", *u.VoteCount)
	}
	if u.RuntimeMin != nil {
		addField("runtime_minutes", *u.RuntimeMin)
	}
	if u.AirDate != nil {
		addField("air_date", *u.AirDate)
	}

	if len(setClauses) == 0 {
		return nil
	}

	query := fmt.Sprintf(`UPDATE tv_episodes SET %s
		WHERE media_item_id = $%d
		AND season_id = (
			SELECT s.id FROM tv_seasons s
			WHERE s.media_item_id = $%d AND s.season_number = $%d
		)
		AND episode_number = $%d`,
		strings.Join(setClauses, ", "), idx, idx+1, idx+2, idx+3)
	args = append(args, u.MediaItemID, u.MediaItemID, u.SeasonNumber, u.EpisodeNumber)

	_, err := q.pool.Exec(ctx, query, args...)
	return err
}

// GetStaleMetadataItems returns items whose metadata is older than maxAge or was never fetched.
func (q *Queries) GetStaleMetadataItems(ctx context.Context, maxAge time.Duration) ([]*models.StaleMediaItem, error) {
	cutoff := time.Now().Add(-maxAge)
	rows, err := q.pool.Query(ctx, `
		SELECT id, library_id, type, title, sort_title, year, overview, rating, runtime_minutes,
		       content_rating, added_at, updated_at, tmdb_id, last_metadata
		FROM media_items
		WHERE last_metadata IS NULL OR last_metadata < $1
		ORDER BY last_metadata ASC NULLS FIRST
		LIMIT 100`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*models.StaleMediaItem
	for rows.Next() {
		item := &models.StaleMediaItem{}
		if err := rows.Scan(&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
			&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin, &item.ContentRating,
			&item.AddedAt, &item.UpdatedAt, &item.TMDBID, &item.LastMetadata); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// TouchLastMetadata bumps the last_metadata timestamp for an item without changing any data.
// Used by smart diffing when TMDB reports no changes since last fetch.
func (q *Queries) TouchLastMetadata(ctx context.Context, mediaItemID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE media_items SET last_metadata = NOW() WHERE id = $1`, mediaItemID)
	return err
}

// UpsertExternalID stores or updates a provider-specific external ID for a media item.
func (q *Queries) UpsertExternalID(ctx context.Context, eid models.ExternalID) error {
	_, err := q.pool.Exec(ctx, `
		INSERT INTO external_ids (media_item_id, provider, external_id)
		VALUES ($1, $2, $3)
		ON CONFLICT (media_item_id, provider) DO UPDATE SET
			external_id = EXCLUDED.external_id`,
		eid.MediaItemID, eid.Provider, eid.ExternalID)
	return err
}

// ============================================================
// Genre management
// ============================================================

// SetMediaGenres replaces all genres for a media item.
//
// Deadlock prevention: genre names are sorted before processing so that all
// concurrent transactions acquire row locks on the shared `genres` table in a
// consistent order. A retry loop with jittered backoff handles any residual
// deadlocks from the DELETE + INSERT pattern or FK lock interactions.
func (q *Queries) SetMediaGenres(ctx context.Context, mediaItemID int64, genreNames []string) error {
	// Deduplicate and sort genre names to ensure consistent lock ordering
	// across concurrent transactions — the primary deadlock prevention measure.
	cleaned := make([]string, 0, len(genreNames))
	seen := make(map[string]struct{}, len(genreNames))
	for _, name := range genreNames {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		lower := strings.ToLower(name)
		if _, dup := seen[lower]; dup {
			continue
		}
		seen[lower] = struct{}{}
		cleaned = append(cleaned, name)
	}
	sort.Strings(cleaned)

	if len(cleaned) == 0 {
		// Nothing to set; just clear any existing genres.
		_, err := q.pool.Exec(ctx, "DELETE FROM media_genres WHERE media_item_id = $1", mediaItemID)
		return err
	}

	const maxRetries = 3
	for attempt := 0; ; attempt++ {
		// 2026-05-19 audit (BE-H4) — bail out if the caller's ctx is
		// almost expired. The previous code would launch retry N
		// inheriting an already-spent context (the failed attempt
		// may have consumed most of a 30s budget), making the retry
		// time out almost immediately and disguising the real issue.
		// 500ms is a soft floor under which a fresh setMediaGenresTx
		// is unlikely to complete; surface the canceled context up
		// instead of attempting an obviously-doomed retry.
		if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < 500*time.Millisecond {
			return fmt.Errorf("ctx near deadline before retry %d: %w", attempt, ctx.Err())
		}

		err := q.setMediaGenresTx(ctx, mediaItemID, cleaned)
		if err == nil {
			return nil
		}

		// Retry only on PostgreSQL deadlock (SQLSTATE 40P01).
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "40P01" {
			return err
		}
		if attempt >= maxRetries-1 {
			return fmt.Errorf("deadlock after %d attempts: %w", maxRetries, err)
		}
		// Jittered backoff: 50-150ms * attempt multiplier.
		backoff := time.Duration(50+rand.IntN(100)) * time.Millisecond * time.Duration(attempt+1)
		slog.Debug("retrying SetMediaGenres after deadlock",
			"item_id", mediaItemID, "attempt", attempt+1, "backoff", backoff)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
	}
}

// setMediaGenresTx runs the genre replacement in a single transaction.
// Genre names must be pre-sorted to prevent deadlocks from inconsistent
// lock ordering on the shared genres table.
func (q *Queries) setMediaGenresTx(ctx context.Context, mediaItemID int64, sortedNames []string) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Clear existing junction rows for this media item.
	_, err = tx.Exec(ctx, "DELETE FROM media_genres WHERE media_item_id = $1", mediaItemID)
	if err != nil {
		return err
	}

	for _, name := range sortedNames {
		// Upsert genre — use DO NOTHING + separate SELECT to avoid the
		// exclusive row lock that DO UPDATE takes on existing rows.
		_, err = tx.Exec(ctx,
			`INSERT INTO genres (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, name)
		if err != nil {
			return err
		}
		var genreID int64
		err = tx.QueryRow(ctx,
			`SELECT id FROM genres WHERE name = $1`, name).Scan(&genreID)
		if err != nil {
			return err
		}

		// Link to media item.
		_, err = tx.Exec(ctx,
			`INSERT INTO media_genres (media_item_id, genre_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			mediaItemID, genreID)
		if err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// ============================================================
// Artwork
// ============================================================

func (q *Queries) UpsertArtwork(ctx context.Context, artworks []models.Artwork) error {
	for _, a := range artworks {
		_, err := q.pool.Exec(ctx, `
			INSERT INTO artwork (media_item_id, art_type, source, remote_path, width, height, lang, vote_average, is_primary, blurhash)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (media_item_id, art_type, source, remote_path) DO UPDATE SET
				width = EXCLUDED.width,
				height = EXCLUDED.height,
				vote_average = EXCLUDED.vote_average,
				is_primary = EXCLUDED.is_primary,
				blurhash = COALESCE(NULLIF(EXCLUDED.blurhash, ''), artwork.blurhash)`,
			a.MediaItemID, a.ArtType, a.Source, a.RemotePath,
			a.Width, a.Height, a.Lang, a.VoteAverage, a.IsPrimary, a.Blurhash)
		if err != nil {
			return err
		}
	}
	return nil
}

func (q *Queries) GetArtwork(ctx context.Context, mediaItemID int64) ([]models.Artwork, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT id, media_item_id, art_type, source, remote_path, COALESCE(local_path, ''),
		       COALESCE(width, 0), COALESCE(height, 0), COALESCE(lang, ''),
		       vote_average, is_primary, COALESCE(blurhash, ''), cached_at, created_at
		FROM artwork
		WHERE media_item_id = $1
		ORDER BY art_type, is_primary DESC, vote_average DESC`, mediaItemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []models.Artwork
	for rows.Next() {
		var a models.Artwork
		if err := rows.Scan(&a.ID, &a.MediaItemID, &a.ArtType, &a.Source, &a.RemotePath,
			&a.LocalPath, &a.Width, &a.Height, &a.Lang, &a.VoteAverage,
			&a.IsPrimary, &a.Blurhash, &a.CachedAt, &a.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, a)
	}
	return result, rows.Err()
}

// GetArtworkMissingBlurhash returns primary artwork that has no blurhash yet.
func (q *Queries) GetArtworkMissingBlurhash(ctx context.Context, limit int) ([]models.Artwork, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT id, media_item_id, art_type, source, remote_path
		FROM artwork
		WHERE is_primary = TRUE AND (blurhash IS NULL OR blurhash = '')
		ORDER BY created_at DESC
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []models.Artwork
	for rows.Next() {
		var a models.Artwork
		if err := rows.Scan(&a.ID, &a.MediaItemID, &a.ArtType, &a.Source, &a.RemotePath); err != nil {
			return nil, err
		}
		result = append(result, a)
	}
	return result, rows.Err()
}

// UpdateArtworkBlurhash stores a computed blurhash for a specific artwork record.
func (q *Queries) UpdateArtworkBlurhash(ctx context.Context, artworkID int64, hash string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE artwork SET blurhash = $1 WHERE id = $2`, hash, artworkID)
	return err
}

// ============================================================
// Cast & Crew
// ============================================================

func (q *Queries) UpsertCast(ctx context.Context, entries []models.CastEntry) error {
	for _, e := range entries {
		// Upsert person
		var personID int64
		err := q.pool.QueryRow(ctx, `
			INSERT INTO people (tmdb_id, name, profile_path, known_for)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (tmdb_id) DO UPDATE SET
				name = EXCLUDED.name,
				profile_path = COALESCE(EXCLUDED.profile_path, people.profile_path)
			RETURNING id`,
			e.TMDBPersonID, e.Name, ptrToStr(e.ProfilePath), e.KnownFor).Scan(&personID)
		if err != nil {
			return fmt.Errorf("upsert person %s: %w", e.Name, err)
		}

		// Upsert cast entry
		_, err = q.pool.Exec(ctx, `
			INSERT INTO media_cast (media_item_id, person_id, role_type, character, display_order)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (media_item_id, person_id, role_type, character) DO UPDATE SET
				display_order = EXCLUDED.display_order`,
			e.MediaItemID, personID, e.RoleType, e.Character, e.DisplayOrder)
		if err != nil {
			return fmt.Errorf("upsert cast %s: %w", e.Name, err)
		}
	}
	return nil
}

func (q *Queries) GetCast(ctx context.Context, mediaItemID int64) ([]models.CastMember, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT p.id, p.name, COALESCE(p.profile_path, ''), mc.role_type, COALESCE(mc.character, ''), mc.display_order
		FROM media_cast mc
		JOIN people p ON p.id = mc.person_id
		WHERE mc.media_item_id = $1
		ORDER BY mc.role_type, mc.display_order`, mediaItemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []models.CastMember
	for rows.Next() {
		var c models.CastMember
		if err := rows.Scan(&c.ID, &c.Name, &c.ProfilePath, &c.RoleType, &c.Character, &c.DisplayOrder); err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

// ============================================================
// TV Show Details
// ============================================================

func (q *Queries) GetSeasons(ctx context.Context, mediaItemID int64) ([]models.Season, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT s.id, s.media_item_id, s.season_number, COALESCE(s.title, ''), COALESCE(s.overview, ''),
		       COUNT(e.id) AS episode_count
		FROM tv_seasons s
		LEFT JOIN tv_episodes e ON e.season_id = s.id
		WHERE s.media_item_id = $1
		GROUP BY s.id
		ORDER BY s.season_number`, mediaItemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var seasons []models.Season
	for rows.Next() {
		var s models.Season
		if err := rows.Scan(&s.ID, &s.MediaItemID, &s.Number, &s.Title, &s.Overview, &s.EpisodeCount); err != nil {
			return nil, err
		}
		seasons = append(seasons, s)
	}
	return seasons, rows.Err()
}

func (q *Queries) GetEpisodes(ctx context.Context, mediaItemID int64, seasonNum int) ([]models.EpisodeDetail, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT e.id, e.season_id, e.media_item_id, e.episode_number,
		       COALESCE(e.title, ''), COALESCE(e.overview, ''),
		       COALESCE(e.runtime_minutes, 0), e.air_date,
		       COALESCE(e.still_path, '')
		FROM tv_episodes e
		JOIN tv_seasons s ON s.id = e.season_id
		WHERE e.media_item_id = $1 AND s.season_number = $2
		ORDER BY e.episode_number`, mediaItemID, seasonNum)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var episodes []models.EpisodeDetail
	for rows.Next() {
		var ep models.EpisodeDetail
		if err := rows.Scan(&ep.ID, &ep.SeasonID, &ep.MediaItemID, &ep.Number,
			&ep.Title, &ep.Overview, &ep.RuntimeMin, &ep.AirDate, &ep.StillPath); err != nil {
			return nil, err
		}
		episodes = append(episodes, ep)
	}
	return episodes, rows.Err()
}

// GetEpisodeFiles returns all files for a specific episode.
func (q *Queries) GetEpisodeFiles(ctx context.Context, episodeID int64) ([]*models.EpisodeFile, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT id, episode_id, path, size_bytes, container, video_codec, audio_codec,
		       resolution, bitrate, duration_ms, file_hash, scanned_at, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt
		FROM episode_files
		WHERE episode_id = $1
		ORDER BY CASE version_tag WHEN '4K' THEN 1 WHEN '1080p' THEN 2 WHEN '720p' THEN 3 ELSE 4 END, id`, episodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []*models.EpisodeFile
	for rows.Next() {
		f := &models.EpisodeFile{}
		var audioJSON, subtitleJSON []byte
		if err := rows.Scan(&f.ID, &f.EpisodeID, &f.Path, &f.SizeBytes, &f.Container,
			&f.VideoCodec, &f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs,
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt); err != nil {
			return nil, err
		}
		// 2026-05-19 audit (BE-H1) — log corrupt JSONB rows instead
		// of silently dropping their tracks (DecidePlayback breaks).
		unmarshalTracks(audioJSON, &f.AudioTracks, f.ID, "audio")
		unmarshalTracks(subtitleJSON, &f.SubtitleTracks, f.ID, "subtitle")
		files = append(files, f)
	}
	return files, rows.Err()
}

// GetSeasonEpisodeCounts returns a map of season_number -> episode_count for a show.
func (q *Queries) GetSeasonEpisodeCounts(ctx context.Context, mediaItemID int64) (int, int, error) {
	var seasonCount, episodeCount int
	err := q.pool.QueryRow(ctx, `
		SELECT COUNT(DISTINCT s.id), COUNT(e.id)
		FROM tv_seasons s
		LEFT JOIN tv_episodes e ON e.season_id = s.id
		WHERE s.media_item_id = $1`, mediaItemID).Scan(&seasonCount, &episodeCount)
	return seasonCount, episodeCount, err
}

// GetNextEpisode returns the next unwatched episode for a show for a given user.
func (q *Queries) GetNextEpisode(ctx context.Context, userID, mediaItemID int64) (*models.EpisodeDetail, error) {
	// Strategy: find the first episode that either has no progress or is not completed,
	// ordered by season then episode number.
	row := q.pool.QueryRow(ctx, `
		SELECT e.id, e.season_id, e.media_item_id, e.episode_number,
		       COALESCE(e.title, ''), COALESCE(e.overview, ''),
		       COALESCE(e.runtime_minutes, 0), e.air_date,
		       COALESCE(e.still_path, '')
		FROM tv_episodes e
		JOIN tv_seasons s ON s.id = e.season_id
		LEFT JOIN watch_progress wp ON wp.episode_id = e.id AND wp.user_id = $1
		WHERE e.media_item_id = $2
		  AND (wp.id IS NULL OR wp.completed = FALSE)
		ORDER BY s.season_number, e.episode_number
		LIMIT 1`, userID, mediaItemID)

	var ep models.EpisodeDetail
	err := row.Scan(&ep.ID, &ep.SeasonID, &ep.MediaItemID, &ep.Number,
		&ep.Title, &ep.Overview, &ep.RuntimeMin, &ep.AirDate, &ep.StillPath)
	if err != nil {
		return nil, err
	}
	return &ep, nil
}

// ============================================================
// Watch Progress
// ============================================================

// UpsertWatchProgress creates or updates watch progress.
// Automatically marks as completed if position >= completion_threshold (default 90%) of duration.
// The threshold is read from the server_settings table ("completion_threshold" key).
func (q *Queries) UpsertWatchProgress(ctx context.Context, p *models.WatchProgress) error {
	// Read completion threshold from DB settings; fall back to 0.90 if unset or invalid.
	threshold := 0.90
	if raw, err := q.GetSetting(ctx, "completion_threshold"); err != nil {
		slog.Warn("failed to read completion_threshold setting, using default", "error", err)
	} else if raw != "" {
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil && parsed >= 0 && parsed <= 1 {
			threshold = parsed
		}
	}

	// Auto-complete when position reaches the configured threshold
	if p.DurationMs > 0 && float64(p.PositionMs)/float64(p.DurationMs) >= threshold {
		p.Completed = true
	}

	// Convert zero ProfileID to nil for nullable DB column
	var profileID interface{}
	if p.ProfileID > 0 {
		profileID = p.ProfileID
	}

	if p.EpisodeID != nil {
		_, err := q.pool.Exec(ctx, `
			INSERT INTO watch_progress (user_id, media_item_id, episode_id, position_ms, duration_ms, completed, profile_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (user_id, episode_id) WHERE episode_id IS NOT NULL
			DO UPDATE SET position_ms = EXCLUDED.position_ms, duration_ms = EXCLUDED.duration_ms,
			             completed = EXCLUDED.completed, profile_id = COALESCE(EXCLUDED.profile_id, watch_progress.profile_id),
			             updated_at = NOW()`,
			p.UserID, p.MediaItemID, p.EpisodeID, p.PositionMs, p.DurationMs, p.Completed, profileID)
		return err
	}

	_, err := q.pool.Exec(ctx, `
		INSERT INTO watch_progress (user_id, media_item_id, position_ms, duration_ms, completed, profile_id)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id, media_item_id) WHERE episode_id IS NULL
		DO UPDATE SET position_ms = EXCLUDED.position_ms, duration_ms = EXCLUDED.duration_ms,
		             completed = EXCLUDED.completed, profile_id = COALESCE(EXCLUDED.profile_id, watch_progress.profile_id),
		             updated_at = NOW()`,
		p.UserID, p.MediaItemID, p.PositionMs, p.DurationMs, p.Completed, profileID)
	return err
}

// GetWatchProgress returns progress for a specific item/episode.
func (q *Queries) GetWatchProgress(ctx context.Context, userID, mediaItemID int64, episodeID *int64) (*models.WatchProgress, error) {
	var wp models.WatchProgress
	var err error

	var profileID *int64
	if episodeID != nil {
		err = q.pool.QueryRow(ctx, `
			SELECT id, user_id, media_item_id, episode_id, position_ms, duration_ms, completed, updated_at, profile_id
			FROM watch_progress WHERE user_id = $1 AND episode_id = $2`,
			userID, *episodeID).Scan(&wp.ID, &wp.UserID, &wp.MediaItemID, &wp.EpisodeID,
			&wp.PositionMs, &wp.DurationMs, &wp.Completed, &wp.UpdatedAt, &profileID)
	} else {
		err = q.pool.QueryRow(ctx, `
			SELECT id, user_id, media_item_id, episode_id, position_ms, duration_ms, completed, updated_at, profile_id
			FROM watch_progress WHERE user_id = $1 AND media_item_id = $2 AND episode_id IS NULL`,
			userID, mediaItemID).Scan(&wp.ID, &wp.UserID, &wp.MediaItemID, &wp.EpisodeID,
			&wp.PositionMs, &wp.DurationMs, &wp.Completed, &wp.UpdatedAt, &profileID)
	}
	if err != nil {
		return nil, err
	}
	if profileID != nil {
		wp.ProfileID = *profileID
	}
	return &wp, nil
}

// GetLatestEpisodeProgress returns the most recent in-progress episode for a TV show.
// Used on the detail page to show "Resume at X:XX" for TV shows (since episode progress
// is stored with episode_id, not at the show level).
func (q *Queries) GetLatestEpisodeProgress(ctx context.Context, userID, mediaItemID int64) (*models.WatchProgress, error) {
	var wp models.WatchProgress
	var profileID *int64
	err := q.pool.QueryRow(ctx, `
		SELECT wp.id, wp.user_id, wp.media_item_id, wp.episode_id, wp.position_ms, wp.duration_ms,
		       wp.completed, wp.updated_at, wp.profile_id
		FROM watch_progress wp
		JOIN tv_episodes e ON e.id = wp.episode_id
		WHERE wp.user_id = $1 AND wp.media_item_id = $2
		  AND wp.episode_id IS NOT NULL AND wp.completed = FALSE AND wp.position_ms > 0
		ORDER BY wp.updated_at DESC LIMIT 1`,
		userID, mediaItemID).Scan(&wp.ID, &wp.UserID, &wp.MediaItemID, &wp.EpisodeID,
		&wp.PositionMs, &wp.DurationMs, &wp.Completed, &wp.UpdatedAt, &profileID)
	if err != nil {
		return nil, err
	}
	if profileID != nil {
		wp.ProfileID = *profileID
	}
	return &wp, nil
}

// GetContinueWatching returns in-progress items for the "Continue Watching" row.
func (q *Queries) GetContinueWatching(ctx context.Context, userID int64, limit int) ([]models.ContinueWatchingItem, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	rows, err := q.pool.Query(ctx, `
		SELECT wp.id, wp.user_id, COALESCE(wp.profile_id, 0), wp.media_item_id, wp.episode_id,
		       wp.position_ms, wp.duration_ms, wp.completed, wp.updated_at,
		       mi.title, COALESCE(mi.poster_path, ''), COALESCE(mi.backdrop_path, ''), mi.type, mi.year,
		       COALESCE(e.title, ''),
		       s.season_number, e.episode_number
		FROM watch_progress wp
		JOIN media_items mi ON mi.id = wp.media_item_id
		LEFT JOIN tv_episodes e ON e.id = wp.episode_id
		LEFT JOIN tv_seasons s ON s.id = e.season_id
		WHERE wp.user_id = $1 AND wp.completed = FALSE AND wp.position_ms > 0
		ORDER BY wp.updated_at DESC
		LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanContinueWatchingRows(rows)
}

// GetContinueWatchingByProfile returns in-progress items scoped to a specific profile.
func (q *Queries) GetContinueWatchingByProfile(ctx context.Context, profileID int64, limit int) ([]models.ContinueWatchingItem, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	rows, err := q.pool.Query(ctx, `
		SELECT wp.id, wp.user_id, COALESCE(wp.profile_id, 0), wp.media_item_id, wp.episode_id,
		       wp.position_ms, wp.duration_ms, wp.completed, wp.updated_at,
		       mi.title, COALESCE(mi.poster_path, ''), COALESCE(mi.backdrop_path, ''), mi.type, mi.year,
		       COALESCE(e.title, ''),
		       s.season_number, e.episode_number
		FROM watch_progress wp
		JOIN media_items mi ON mi.id = wp.media_item_id
		LEFT JOIN tv_episodes e ON e.id = wp.episode_id
		LEFT JOIN tv_seasons s ON s.id = e.season_id
		WHERE wp.profile_id = $1 AND wp.completed = FALSE AND wp.position_ms > 0
		ORDER BY wp.updated_at DESC
		LIMIT $2`, profileID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanContinueWatchingRows(rows)
}

// ============================================================
// Enriched Media Item (with TMDB fields)
// ============================================================

// GetMediaGenresBatch returns genre names for multiple media items in a single query.
// Returns a map of mediaItemID → []string (genre names).
func (q *Queries) GetMediaGenresBatch(ctx context.Context, mediaItemIDs []int64) (map[int64][]string, error) {
	if len(mediaItemIDs) == 0 {
		return map[int64][]string{}, nil
	}
	rows, err := q.pool.Query(ctx, `
		SELECT mg.media_item_id, g.name
		FROM media_genres mg
		JOIN genres g ON g.id = mg.genre_id
		WHERE mg.media_item_id = ANY($1)
		ORDER BY mg.media_item_id, g.name`, mediaItemIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[int64][]string)
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		result[id] = append(result[id], name)
	}
	return result, rows.Err()
}

// GetMediaGenres returns genre names for a media item.
func (q *Queries) GetMediaGenres(ctx context.Context, mediaItemID int64) ([]string, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT g.name FROM genres g
		JOIN media_genres mg ON mg.genre_id = g.id
		WHERE mg.media_item_id = $1
		ORDER BY g.name`, mediaItemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var genres []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		genres = append(genres, name)
	}
	return genres, rows.Err()
}

// GetMediaItemEnriched returns a media item with all TMDB-enriched fields.
func (q *Queries) GetMediaItemEnriched(ctx context.Context, id int64) (*models.MediaItemEnriched, error) {
	row := q.pool.QueryRow(ctx, `
		SELECT id, library_id, type, title, sort_title, year, overview, rating, runtime_minutes,
		       content_rating, added_at, updated_at,
		       tmdb_id, COALESCE(imdb_id, ''), COALESCE(tagline, ''),
		       COALESCE(poster_path, ''), COALESCE(backdrop_path, '')
		FROM media_items WHERE id = $1`, id)

	item := &models.MediaItem{}
	enriched := &models.MediaItemEnriched{MediaItem: item}

	err := row.Scan(&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
		&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin, &item.ContentRating,
		&item.AddedAt, &item.UpdatedAt,
		&enriched.TMDBID, &enriched.IMDbID, &enriched.Tagline,
		&item.PosterPath, &item.BackdropPath)
	if err != nil {
		return nil, err
	}

	return enriched, nil
}

// GetMediaFileByID returns a media file by its primary key.
func (q *Queries) GetMediaFileByID(ctx context.Context, id int64) (*models.MediaFile, error) {
	f := &models.MediaFile{}
	var audioJSON, subtitleJSON []byte
	err := q.pool.QueryRow(ctx, `
		SELECT id, media_item_id, path, size_bytes, container, video_codec, audio_codec,
		       resolution, bitrate, duration_ms, file_hash, scanned_at, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt
		FROM media_files WHERE id = $1`, id).
		Scan(&f.ID, &f.MediaItemID, &f.Path, &f.SizeBytes, &f.Container,
			&f.VideoCodec, &f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs,
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt)
	if err != nil {
		return nil, err
	}
	// 2026-05-19 audit (BE-H1) — log corrupt JSONB rows.
	unmarshalTracks(audioJSON, &f.AudioTracks, f.ID, "audio")
	unmarshalTracks(subtitleJSON, &f.SubtitleTracks, f.ID, "subtitle")
	return f, nil
}

// GetEpisodeFileByID returns an episode file by its primary key.
func (q *Queries) GetEpisodeFileByID(ctx context.Context, id int64) (*models.EpisodeFile, error) {
	f := &models.EpisodeFile{}
	var audioJSON, subtitleJSON []byte
	err := q.pool.QueryRow(ctx, `
		SELECT id, episode_id, path, size_bytes, container, video_codec, audio_codec,
		       resolution, bitrate, duration_ms, file_hash, scanned_at, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt
		FROM episode_files WHERE id = $1`, id).
		Scan(&f.ID, &f.EpisodeID, &f.Path, &f.SizeBytes, &f.Container,
			&f.VideoCodec, &f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs,
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt)
	if err != nil {
		return nil, err
	}
	// 2026-05-19 audit (BE-H1) — log corrupt JSONB rows.
	unmarshalTracks(audioJSON, &f.AudioTracks, f.ID, "audio")
	unmarshalTracks(subtitleJSON, &f.SubtitleTracks, f.ID, "subtitle")
	return f, nil
}

// ============================================================
// Version Tag Queries
// ============================================================

// GetMediaItemsWith4K returns a set of media_item_ids that have at least one
// file with a version_tag starting with "4K" (matches "4K" and "4K HDR").
// Used by the API layer to annotate list responses with has_4k badges.
func (q *Queries) GetMediaItemsWith4K(ctx context.Context, mediaItemIDs []int64) (map[int64]bool, error) {
	if len(mediaItemIDs) == 0 {
		return map[int64]bool{}, nil
	}
	rows, err := q.pool.Query(ctx,
		`SELECT DISTINCT media_item_id FROM media_files
		 WHERE media_item_id = ANY($1) AND version_tag LIKE '4K%'
		 UNION
		 SELECT DISTINCT e.media_item_id FROM episode_files ef
		 JOIN tv_episodes e ON e.id = ef.episode_id
		 WHERE e.media_item_id = ANY($1) AND ef.version_tag LIKE '4K%'`, mediaItemIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[int64]bool, len(mediaItemIDs))
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result[id] = true
	}
	return result, rows.Err()
}

// ============================================================
// Helpers
// ============================================================

func ptrToStr(p *string) interface{} {
	if p == nil {
		return nil
	}
	return *p
}

// ============================================================
// TV Upserts (for scanner)
// ============================================================

// UpsertSeason creates or finds a season for a TV show. Returns the season ID.
func (q *Queries) UpsertSeason(ctx context.Context, mediaItemID int64, seasonNumber int) (int64, error) {
	var id int64
	err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_seasons (media_item_id, season_number)
		 VALUES ($1, $2)
		 ON CONFLICT (media_item_id, season_number) DO UPDATE SET media_item_id = EXCLUDED.media_item_id
		 RETURNING id`,
		mediaItemID, seasonNumber,
	).Scan(&id)
	return id, err
}

// UpsertEpisode creates or finds an episode. Returns the episode ID.
func (q *Queries) UpsertEpisode(ctx context.Context, seasonID, mediaItemID int64, episodeNumber int) (int64, error) {
	var id int64
	err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_episodes (season_id, media_item_id, episode_number)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (season_id, episode_number) DO UPDATE SET media_item_id = EXCLUDED.media_item_id
		 RETURNING id`,
		seasonID, mediaItemID, episodeNumber,
	).Scan(&id)
	return id, err
}

// UpsertEpisodeFile upserts a file entry for an episode.
func (q *Queries) UpsertEpisodeFile(ctx context.Context, f *models.EpisodeFile) error {
	aj, sj := marshalTracks(f.AudioTracks, f.SubtitleTracks)
	return q.pool.QueryRow(ctx,
		`INSERT INTO episode_files (episode_id, path, size_bytes, container, video_codec, audio_codec, resolution, bitrate, duration_ms, file_hash, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		 ON CONFLICT (path) DO UPDATE SET
		   episode_id = EXCLUDED.episode_id,
		   size_bytes = EXCLUDED.size_bytes, container = EXCLUDED.container,
		   video_codec = EXCLUDED.video_codec, audio_codec = EXCLUDED.audio_codec,
		   resolution = EXCLUDED.resolution, bitrate = EXCLUDED.bitrate,
		   duration_ms = EXCLUDED.duration_ms, file_hash = EXCLUDED.file_hash,
		   audio_tracks = EXCLUDED.audio_tracks, subtitle_tracks = EXCLUDED.subtitle_tracks,
		   version_tag = EXCLUDED.version_tag,
		   video_profile = EXCLUDED.video_profile, video_pix_fmt = EXCLUDED.video_pix_fmt,
		   scanned_at = NOW()
		 RETURNING id, scanned_at`,
		f.EpisodeID, f.Path, f.SizeBytes, f.Container, f.VideoCodec,
		f.AudioCodec, f.Resolution, f.Bitrate, f.DurationMs, f.FileHash, aj, sj, f.VersionTag,
		f.VideoProfile, f.VideoPixFmt,
	).Scan(&f.ID, &f.ScannedAt)
}

// GetEpisodeFileByPath returns an episode file by its filesystem path.
func (q *Queries) GetEpisodeFileByPath(ctx context.Context, path string) (*models.EpisodeFile, error) {
	f := &models.EpisodeFile{}
	var audioJSON, subtitleJSON []byte
	err := q.pool.QueryRow(ctx,
		`SELECT id, episode_id, path, size_bytes, container, video_codec, audio_codec, resolution, bitrate, duration_ms, file_hash, scanned_at, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt
		 FROM episode_files WHERE path = $1`, path,
	).Scan(&f.ID, &f.EpisodeID, &f.Path, &f.SizeBytes, &f.Container, &f.VideoCodec,
		&f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs, &f.FileHash, &f.ScannedAt,
		&audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get episode file: %w", err)
	}
	// 2026-05-19 audit (BE-H1) — log corrupt JSONB rows.
	unmarshalTracks(audioJSON, &f.AudioTracks, f.ID, "audio")
	unmarshalTracks(subtitleJSON, &f.SubtitleTracks, f.ID, "subtitle")
	return f, nil
}

// GetEpisodeNowPlayingInfo returns the show title, season/episode numbers, and episode title
// for a given episode ID. Used for now_playing broadcast context.
func (q *Queries) GetEpisodeNowPlayingInfo(ctx context.Context, episodeID int64) (showTitle string, seasonNum int, episodeNum int, episodeTitle string, err error) {
	err = q.pool.QueryRow(ctx, `
		SELECT mi.title, s.season_number, e.episode_number, COALESCE(e.title, '')
		FROM tv_episodes e
		JOIN tv_seasons s ON s.id = e.season_id
		JOIN media_items mi ON mi.id = e.media_item_id
		WHERE e.id = $1`, episodeID).Scan(&showTitle, &seasonNum, &episodeNum, &episodeTitle)
	return
}
