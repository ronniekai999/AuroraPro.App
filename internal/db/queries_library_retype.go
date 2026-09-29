package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/aurora-media/aurora/internal/models"
)

// Changing a library's type (issue #510).
//
// A library created with the wrong type is unrecoverable from the UI today, and
// the owner's "TV Shows" library was created as type='movie'. UpdateLibrary only
// ever wrote `name`, so the only remedy was hand-written SQL against production.
//
// A bare `UPDATE libraries SET type` is ACTIVELY HARMFUL and must not be what
// this does. The existing media_items keep the old type, their files stay in the
// wrong table, and pruneDeletedFiles branches on the same `isTV` the scanner
// does — so after the flip the scanner walks the library as TV, finds no
// episode_files rows for any of it, and the orphaned media_files rows are never
// reachable by any prune again. Permanent phantoms, on top of a catalog that
// still reads as movies.
//
// So the operation is a PURGE and a rescan, not an edit. Everything of the wrong
// type is deleted, the type is changed, and the library is walked again from
// disk under the right parser. That destroys catalog history for those titles
// — watch progress, watchlist entries, ratings — and the preview exists so an
// admin sees exactly what, before it happens rather than after.
//
// CLAUDE.md's withdrawn-repointing post-mortem is the reason this is shaped this
// way: five reviews each found a distinct way an earlier attempt destroyed
// catalog history, four of them by RUNNING code against Postgres. The deliberate
// non-goal here is preserving anything across the retype. Re-parenting a movie
// row's history onto a show row it has no relationship to is exactly the
// premise that was false last time (UpsertMediaItem keys on the FILENAME while
// the stored row carries what enrichment wrote), and guessing wrong there loses
// data silently instead of loudly.

// RetypeCasualty is one child table and how many of its rows a retype destroys.
type RetypeCasualty struct {
	Table string `json:"table"`
	Rows  int64  `json:"rows"`
	// Why is the same one-line description the merge code carries for this
	// table, so the preview says what the rows MEAN rather than naming a table
	// an admin has no reason to recognise.
	Why string `json:"why"`
}

// RetypePreview is everything a retype would delete, counted before anything is
// deleted.
type RetypePreview struct {
	LibraryID   int64              `json:"library_id"`
	LibraryName string             `json:"library_name"`
	CurrentType models.LibraryType `json:"current_type"`
	TargetType  models.LibraryType `json:"target_type"`
	// ItemsToDelete is the interlock. It is echoed back on the confirm call and
	// the transaction refuses if the catalog has moved since.
	ItemsToDelete int64 `json:"items_to_delete"`
	ItemsKept     int64 `json:"items_kept"`
	// Casualties lists only the tables that actually lose rows; a preview
	// listing nineteen zeroes buries the two lines that matter.
	Casualties []RetypeCasualty `json:"casualties"`
}

// mediaTypeForLibrary maps a library's type to the media_items.type its rows
// carry. The scanner writes one or the other from the same `isTV` branch this
// whole issue is about, so the mapping is not incidental.
func mediaTypeForLibrary(t models.LibraryType) (models.MediaType, error) {
	switch t {
	case models.LibraryMovies:
		return models.MediaMovie, nil
	case models.LibraryShows:
		return models.MediaShow, nil
	default:
		return "", fmt.Errorf("unknown library type %q", t)
	}
}

// PreviewLibraryRetype counts what changing the library's type would destroy.
// Read-only.
//
// The casualty list is DERIVED from mergeChildren rather than hand-written, and
// that is the point: mergeChildren is already pinned against pg_constraint by a
// drift guard, so a future ON DELETE CASCADE child of media_items cannot appear
// without landing in that list — and therefore cannot be silently absent from
// this preview. A hand-maintained list here would go stale exactly the way
// MergeMediaItems' did, and the cost of being wrong is an admin confirming a
// deletion whose size they were told incorrectly.
//
// episode_files is counted separately because it cascades from tv_episodes
// rather than from media_items, so it is deliberately NOT in mergeChildren.
func (q *Queries) PreviewLibraryRetype(ctx context.Context, libraryID int64, target models.LibraryType) (*RetypePreview, error) {
	wantMedia, err := mediaTypeForLibrary(target)
	if err != nil {
		return nil, err
	}

	p := &RetypePreview{LibraryID: libraryID, TargetType: target}
	err = q.pool.QueryRow(ctx,
		`SELECT name, type FROM libraries WHERE id = $1`, libraryID).
		Scan(&p.LibraryName, &p.CurrentType)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("preview retype: read library: %w", err)
	}

	err = q.pool.QueryRow(ctx, `
		SELECT COUNT(*) FILTER (WHERE type <> $2),
		       COUNT(*) FILTER (WHERE type =  $2)
		FROM media_items WHERE library_id = $1`, libraryID, wantMedia).
		Scan(&p.ItemsToDelete, &p.ItemsKept)
	if err != nil {
		return nil, fmt.Errorf("preview retype: count items: %w", err)
	}
	if p.ItemsToDelete == 0 {
		return p, nil
	}

	doomed := `SELECT id FROM media_items WHERE library_id = $1 AND type <> $2`
	for _, m := range mergeChildren {
		var n int64
		if err := q.pool.QueryRow(ctx, fmt.Sprintf(
			`SELECT COUNT(*) FROM %s WHERE media_item_id IN (%s)`, m.table, doomed),
			libraryID, wantMedia).Scan(&n); err != nil {
			return nil, fmt.Errorf("preview retype: count %s: %w", m.table, err)
		}
		if n > 0 {
			p.Casualties = append(p.Casualties, RetypeCasualty{Table: m.table, Rows: n, Why: m.why})
		}
	}

	var episodeFiles int64
	if err := q.pool.QueryRow(ctx, fmt.Sprintf(`
		SELECT COUNT(*) FROM episode_files ef
		JOIN tv_episodes te ON te.id = ef.episode_id
		WHERE te.media_item_id IN (%s)`, doomed), libraryID, wantMedia).Scan(&episodeFiles); err != nil {
		return nil, fmt.Errorf("preview retype: count episode_files: %w", err)
	}
	if episodeFiles > 0 {
		p.Casualties = append(p.Casualties, RetypeCasualty{
			Table: "episode_files", Rows: episodeFiles,
			Why: "cascades from tv_episodes; re-created by the rescan",
		})
	}
	return p, nil
}

// ErrRetypeCountMismatch is returned when the catalog moved between the preview
// and the confirm. The caller turns it into a 409.
type ErrRetypeCountMismatch struct {
	Expected int64
	Actual   int64
}

func (e *ErrRetypeCountMismatch) Error() string {
	return fmt.Sprintf("library changed since the preview: %d items would be deleted, not %d", e.Actual, e.Expected)
}

// RetypeLibrary purges every media item of the wrong type and sets the new type,
// in ONE transaction, refusing if the count no longer matches what the caller
// was shown.
//
// The count interlock is the whole safety model, and it is checked INSIDE the
// transaction after taking the row lock — checking it outside would leave the
// window this exists to close. A scan finishing, a file landing, or a second
// admin acting between the preview and the confirm all change what gets deleted,
// and an admin who approved "80 titles" must not silently get 400.
//
// SELECT ... FOR UPDATE on the library row serialises two concurrent retypes of
// the same library; the scan slot the caller holds covers scans.
//
// Returns the number of items deleted.
//
// Calling this with the type the library ALREADY has is allowed and is not a
// no-op: it purges rows whose type disagrees with the library's. That is the
// repair path for a library whose type was corrected by hand in SQL — precisely
// what was done to production — leaving a library marked 'show' still full of
// 'movie' rows.
func (q *Queries) RetypeLibrary(ctx context.Context, libraryID int64, target models.LibraryType, expectedItems int64) (int64, error) {
	wantMedia, err := mediaTypeForLibrary(target)
	if err != nil {
		return 0, err
	}

	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("retype: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	var exists int64
	if err := tx.QueryRow(ctx,
		`SELECT id FROM libraries WHERE id = $1 FOR UPDATE`, libraryID).Scan(&exists); err != nil {
		if err == pgx.ErrNoRows {
			return 0, nil
		}
		return 0, fmt.Errorf("retype: lock library: %w", err)
	}

	var actual int64
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM media_items WHERE library_id = $1 AND type <> $2`,
		libraryID, wantMedia).Scan(&actual); err != nil {
		return 0, fmt.Errorf("retype: recount: %w", err)
	}
	if actual != expectedItems {
		return 0, &ErrRetypeCountMismatch{Expected: expectedItems, Actual: actual}
	}

	tag, err := tx.Exec(ctx,
		`DELETE FROM media_items WHERE library_id = $1 AND type <> $2`, libraryID, wantMedia)
	if err != nil {
		return 0, fmt.Errorf("retype: purge items: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE libraries SET type = $2, updated_at = NOW() WHERE id = $1`,
		libraryID, target); err != nil {
		return 0, fmt.Errorf("retype: set type: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("retype: commit: %w", err)
	}
	return tag.RowsAffected(), nil
}
