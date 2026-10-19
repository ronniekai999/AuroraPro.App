package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// Phase 6 — Collections queries.
//
// Visibility rule: a user sees their OWN collections + any public ones.
// Mutations require ownership (or admin role, gated at the handler).
//
// Reads take allowedRatings, the reader's ceiling (db.AllowedRatingsForMax;
// nil is unrestricted): members over it are left out of the items, the
// counts, the poster mosaic and the cover. A collection is shared (public
// ones with every user, private ones with the owner's whole account), so its
// contents are filtered per reader rather than when they are added.

// ListCollectionsForUser returns all collections visible to userID.
// When isAdmin is true the visibility filter is dropped — admins
// see EVERY collection (owned, public, AND others' private ones)
// so they can manage/curate the full server library. Audit M1 fix.
// Ordered by updated_at desc so freshly-modified collections surface
// first.
// posterPathsSelect is the up-to-four member posters each row carries for the
// collections grid's stacked-poster card (Aurora Stage Phase 6). Ordered by
// (position, id) to match the index on collection_items(collection_id,
// position) and to agree with the order the collection detail view lists its
// members in — so the mosaic is the first four titles you'd see inside, not an
// arbitrary four.
//
// Empty poster_paths are filtered out rather than returned as blanks: a
// half-scanned collection would otherwise render gaps, and the card can lay
// out any count from 0 to 4. COALESCE keeps the column non-NULL so the scan
// target can be a plain []string.
const posterPathsSelect = `
	COALESCE((
	  SELECT array_agg(p.poster_path)
	    FROM (SELECT mi.poster_path
	            FROM collection_items ci
	            JOIN media_items mi ON mi.id = ci.media_item_id
	           WHERE ci.collection_id = c.id
	             AND COALESCE(mi.poster_path, '') <> ''
	             AND ($1::text[] IS NULL OR mi.content_rating = ANY($1))
	           ORDER BY ci.position, ci.id
	           LIMIT 4) p
	), '{}') AS poster_paths`

// collectionSummarySelect is a collection row's columns as the reader with
// ceiling $1 sees them. Under a ceiling the cover is the first allowed
// member's poster: the stored cover_path is copied from whichever title was
// added first, which may be over it.
const collectionSummarySelect = `
	c.id, c.owner_user_id, c.name, COALESCE(c.description, ''),
	c.kind, COALESCE(c.prompt, ''), c.is_public,
	CASE WHEN $1::text[] IS NULL THEN COALESCE(c.cover_path, '')
	     ELSE COALESCE((
	       SELECT mi.poster_path
	         FROM collection_items ci
	         JOIN media_items mi ON mi.id = ci.media_item_id
	        WHERE ci.collection_id = c.id
	          AND COALESCE(mi.poster_path, '') <> ''
	          AND mi.content_rating = ANY($1)
	        ORDER BY ci.position, ci.id
	        LIMIT 1), '') END,
	(SELECT COUNT(*)
	   FROM collection_items ci
	   JOIN media_items mi ON mi.id = ci.media_item_id
	  WHERE ci.collection_id = c.id
	    AND ($1::text[] IS NULL OR mi.content_rating = ANY($1))) AS item_count,
	c.created_at, c.updated_at`

func (q *Queries) ListCollectionsForUser(ctx context.Context, userID int64, isAdmin bool, allowedRatings []string) ([]*models.Collection, error) {
	sql := `
		SELECT` + collectionSummarySelect + `,` + posterPathsSelect + `
		  FROM collections c
		 WHERE $3::bool OR c.owner_user_id = $2 OR c.is_public = true
		 ORDER BY c.updated_at DESC
	`
	rows, err := q.pool.Query(ctx, sql, allowedRatings, userID, isAdmin)
	if err != nil {
		return nil, fmt.Errorf("list collections: %w", err)
	}
	defer rows.Close()
	out := []*models.Collection{}
	for rows.Next() {
		c := &models.Collection{}
		if err := rows.Scan(&c.ID, &c.OwnerUserID, &c.Name, &c.Description,
			&c.Kind, &c.Prompt, &c.IsPublic, &c.CoverPath,
			&c.ItemCount, &c.CreatedAt, &c.UpdatedAt, &c.PosterPaths); err != nil {
			return nil, fmt.Errorf("scan collection: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetCollection reads one collection as a reader with allowedRatings sees it
// (nil for an ownership check, which needs no member data).
func (q *Queries) GetCollection(ctx context.Context, id int64, allowedRatings []string) (*models.Collection, error) {
	c := &models.Collection{}
	err := q.pool.QueryRow(ctx, `
		SELECT`+collectionSummarySelect+`
		  FROM collections c WHERE c.id = $2
	`, allowedRatings, id).Scan(&c.ID, &c.OwnerUserID, &c.Name, &c.Description,
		&c.Kind, &c.Prompt, &c.IsPublic, &c.CoverPath, &c.ItemCount,
		&c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("get collection: %w", err)
	}
	return c, nil
}

func (q *Queries) CreateCollection(ctx context.Context, c *models.Collection) error {
	kind := c.Kind
	if kind == "" {
		kind = "manual"
	}
	return q.pool.QueryRow(ctx, `
		INSERT INTO collections (owner_user_id, name, description, kind, prompt, is_public, cover_path)
		VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), $6, NULLIF($7, ''))
		RETURNING id, created_at, updated_at
	`, c.OwnerUserID, c.Name, c.Description, kind, c.Prompt, c.IsPublic, c.CoverPath).
		Scan(&c.ID, &c.CreatedAt, &c.UpdatedAt)
}

func (q *Queries) DeleteCollection(ctx context.Context, id int64) error {
	_, err := q.pool.Exec(ctx, `DELETE FROM collections WHERE id = $1`, id)
	return err
}

// ListCollectionItems returns the media items in a collection that
// allowedRatings allows (nil: all of them), joined to media_items so callers
// get titles/posters in one round-trip. Ordered by position then added_at to
// maintain explicit-order + stable tie-break.
func (q *Queries) ListCollectionItems(ctx context.Context, collectionID int64, allowedRatings []string) ([]*models.MediaItem, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT m.id, m.library_id, m.title, COALESCE(m.sort_title, ''), m.type,
		       COALESCE(m.year, 0), COALESCE(m.overview, ''), COALESCE(m.rating, 0),
		       COALESCE(m.runtime_minutes, 0), COALESCE(m.content_rating, ''),
		       COALESCE(m.poster_path, ''), COALESCE(m.backdrop_path, ''),
		       m.added_at, m.updated_at
		  FROM collection_items ci
		  JOIN media_items m ON m.id = ci.media_item_id
		 WHERE ci.collection_id = $1
		   AND ($2::text[] IS NULL OR m.content_rating = ANY($2))
		 ORDER BY ci.position ASC, ci.added_at ASC
	`, collectionID, allowedRatings)
	if err != nil {
		return nil, fmt.Errorf("list collection items: %w", err)
	}
	defer rows.Close()
	out := []*models.MediaItem{}
	for rows.Next() {
		m := &models.MediaItem{}
		if err := rows.Scan(&m.ID, &m.LibraryID, &m.Title, &m.SortTitle, &m.Type,
			&m.Year, &m.Overview, &m.Rating, &m.RuntimeMin, &m.ContentRating,
			&m.PosterPath, &m.BackdropPath, &m.AddedAt, &m.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan collection item: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// AddToCollection inserts (collectionID, mediaItemID) ignoring
// duplicates (UNIQUE constraint catches re-adds silently). Position
// auto-increments based on current max so new items append to end.
//
// Audit L1 fix — auto-populates cover_path on the FIRST item add
// when the collection has no cover set. Picks the added media's
// poster_path. Later edits can override via a future API; for now
// this gives every collection a sensible default cover.
func (q *Queries) AddToCollection(ctx context.Context, collectionID, mediaItemID int64) error {
	_, err := q.pool.Exec(ctx, `
		INSERT INTO collection_items (collection_id, media_item_id, position)
		VALUES ($1, $2, COALESCE(
		  (SELECT MAX(position) + 1 FROM collection_items WHERE collection_id = $1),
		  0
		))
		ON CONFLICT (collection_id, media_item_id) DO NOTHING
	`, collectionID, mediaItemID)
	if err != nil {
		return fmt.Errorf("add to collection: %w", err)
	}
	// Bump updated_at + auto-populate cover_path if missing.
	// `updated_at = NOW()` always fires. The COALESCE/NULLIF dance on
	// cover_path: if current is NULL or empty, pull poster_path from
	// the just-added media item; otherwise leave alone. Done in a
	// single UPDATE so we don't race a separate SELECT/UPDATE pair.
	_, _ = q.pool.Exec(ctx, `
		UPDATE collections c
		   SET updated_at = NOW(),
		       cover_path = COALESCE(
		         NULLIF(c.cover_path, ''),
		         (SELECT NULLIF(m.poster_path, '')
		            FROM media_items m WHERE m.id = $2)
		       )
		 WHERE c.id = $1
	`, collectionID, mediaItemID)
	return nil
}

func (q *Queries) RemoveFromCollection(ctx context.Context, collectionID, mediaItemID int64) error {
	_, err := q.pool.Exec(ctx, `
		DELETE FROM collection_items
		 WHERE collection_id = $1 AND media_item_id = $2
	`, collectionID, mediaItemID)
	return err
}
