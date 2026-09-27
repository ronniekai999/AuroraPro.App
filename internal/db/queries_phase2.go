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
	if u.Studio != nil {
		addField("studio", *u.Studio)
	}
	if u.Network != nil {
		addField("network", *u.Network)
	}
	if u.ReleaseDate != nil {
		addField("release_date", *u.ReleaseDate)
	}
	if u.TrailerKey != nil {
		addField("trailer_key", *u.TrailerKey)
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
	//
	// mi2.type = mi1.type because TMDB's movie and TV id spaces are independent,
	// so a shared numeric id is not evidence of the same title. Today every row
	// in one library shares that library's type (UpsertMediaItem is the only
	// INSERT and takes the type from lib.Type; nothing ever UPDATEs it), which
	// makes this predicate redundant — but no constraint enforces that, and what
	// this query feeds is a catalog MERGE, which CLAUDE.md names the most
	// dangerous code in this repo. Keeping the invariant local costs nothing.
	if u.TMDBID != nil && *u.TMDBID > 0 {
		var canonicalID int64
		err := q.pool.QueryRow(ctx,
			`SELECT mi2.id FROM media_items mi1
			 JOIN media_items mi2 ON mi2.tmdb_id = mi1.tmdb_id
			   AND mi2.library_id = mi1.library_id AND mi2.type = mi1.type
			   AND mi2.id != mi1.id
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

// MergeMediaItems reassigns every child record from duplicateID to canonicalID
// and then deletes the duplicate. Used when enrichment discovers that two
// separately-created media items are the same movie or show.
//
// Deliberately does NOT enumerate the tables here. It used to, and the list went
// stale: eleven cascade children were added by later migrations and nobody
// revisited the function, so the final DELETE destroyed all of them. The list
// lives in mergeChildren, the generic loop is DRIVEN by it, and the tests derive
// their expectations from it too.
//
// The dangerous property to preserve: media_items has ON DELETE CASCADE children,
// so anything not re-parented before the final DELETE is destroyed silently.
// CLAUDE.md calls this the most dangerous code in the repo.
func (q *Queries) MergeMediaItems(ctx context.Context, canonicalID, duplicateID int64) error {
	// L3: a self-merge would be strictly destructive — every collision check
	// below matches the row against itself, so nothing moves and the DELETEs
	// then strip the item's own watchlist entries, ratings, feedback, taste
	// seeds and recaps before the final DELETE finishes it off. The only
	// caller cannot do this (findCanonicalItem excludes the row by id), which
	// is exactly why it is worth one cheap line here.
	if canonicalID == duplicateID {
		return nil
	}
	if err := mergeChildStrategyError(mergeChildren, mergeEpisodeChildren); err != nil {
		return err
	}
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
	// MED audit fix: check the cursor error after iterating. A mid-stream
	// cursor failure (e.g. dropped connection) ends rows.Next() early with a
	// PARTIAL dupSeasons slice; without this check the merge would proceed and
	// silently leave the un-iterated seasons (and their episodes/files/
	// watch_progress) pointing at the about-to-be-deleted duplicate, losing
	// them to the FK CASCADE on DELETE FROM media_items. Returning here lets the
	// deferred tx.Rollback abort the whole merge atomically.
	seasonsErr := rows.Err()
	rows.Close()
	if seasonsErr != nil {
		return fmt.Errorf("iterate dup seasons: %w", seasonsErr)
	}

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
			// MED audit fix: same cursor-error guard as the seasons loop
			// above. A partial dupEps slice from a mid-stream cursor failure
			// would otherwise let the merge delete the duplicate season (and
			// CASCADE-delete its un-reassigned episodes / episode_files /
			// watch_progress). Return to trigger the deferred tx.Rollback.
			epRowsErr := epRows.Err()
			epRows.Close()
			if epRowsErr != nil {
				return fmt.Errorf("iterate dup episodes: %w", epRowsErr)
			}

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
					// profile_id is part of the collision key. The unique index is
					// idx_watch_progress_user_profile_episode ON
					// (user_id, profile_id, episode_id) WHERE episode_id IS NOT NULL,
					// so comparing user_id alone judges a SIBLING PROFILE's progress
					// a collision: an adult with progress on the canonical episode
					// made a kid profile's progress on the duplicate unmovable, and
					// the DELETE below then destroyed it. Same shape as the
					// recently_surfaced_items key — a partial key does not error, it
					// silently drops a third party's row.
					_, _ = tx.Exec(ctx,
						`UPDATE watch_progress SET episode_id = $1, media_item_id = $2
						 WHERE episode_id = $3
						 AND NOT EXISTS (
						   SELECT 1 FROM watch_progress wp2
						   WHERE wp2.user_id = watch_progress.user_id
						     AND wp2.profile_id = watch_progress.profile_id
						     AND wp2.episode_id = $1
						 )`,
						canonEpID, canonicalID, de.id)
					// Delete any remaining dup watch_progress (conflict cases)
					_, _ = tx.Exec(ctx,
						`DELETE FROM watch_progress WHERE episode_id = $1`, de.id)
					// Re-point the episode's OTHER children before it goes.
					// Deleting the duplicate episode cascades
					// recommendation_watch_events and episode_recaps away, and
					// nulls watch_parties.episode_id and
					// recap_conversation_turns.up_to_episode_id — so a live party
					// came out of a merge as a show with no episode, which
					// rehydrate.go then reloads pointing at nothing.
					if err := repointEpisodeChildren(ctx, tx, canonEpID, de.id); err != nil {
						return err
					}
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
	// profile_id is part of the collision key here too — the unique index is
	// idx_watch_progress_user_profile_media ON (user_id, profile_id, media_item_id)
	// WHERE episode_id IS NULL. See the episode variant above for what omitting it
	// destroyed.
	_, _ = tx.Exec(ctx,
		`UPDATE watch_progress SET media_item_id = $1
		 WHERE media_item_id = $2 AND episode_id IS NULL
		 AND NOT EXISTS (
		   SELECT 1 FROM watch_progress wp2
		   WHERE wp2.user_id = watch_progress.user_id
		     AND wp2.profile_id = watch_progress.profile_id
		     AND wp2.media_item_id = $1 AND wp2.episode_id IS NULL
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

	// Everything below was NOT re-parented before, and the final DELETE's
	// ON DELETE CASCADE therefore destroyed it. media_items has 19 cascade
	// children; this function handled 8 of them, and the other 11 arrived in
	// migrations written after it — the classic drift. The loss was silent,
	// unlogged and unrecoverable, and it took user data with it: a watchlist
	// entry and a 5-star rating on the duplicate both went to zero across a
	// merge, confirmed by running it.
	//
	// The loop is DRIVEN by mergeChildren. An earlier version kept that list
	// purely as a cross-check, which a review defeated in one line: adding an
	// entry turned the drift guard green while every row in the new table was
	// still destroyed. A classification that does not cause handling is a
	// comment, not a guard.
	//
	// Policy on a collision, matching what watch_progress does: the CANONICAL
	// row wins and the duplicate's is dropped. These are per-profile opinions
	// and the canonical item is the one the user keeps seeing.
	for _, m := range mergeChildren {
		if m.bespoke {
			continue // handled by the hand-written walk above
		}
		if len(m.keyCols) == 0 {
			// No unique index involves media_item_id, so nothing can collide and
			// every row moves. watch_parties matters most here: it can be a LIVE
			// room, and deleting it dropped every participant mid-session.
			if _, err := tx.Exec(ctx, fmt.Sprintf(
				`UPDATE %s SET media_item_id = $1 WHERE media_item_id = $2`, m.table),
				canonicalID, duplicateID); err != nil {
				return fmt.Errorf("reassign %s: %w", m.table, err)
			}
			continue
		}
		// recap_conversations owns recap_conversation_turns/_requests, so the
		// duplicate's conversation cannot simply be dropped on a collision —
		// that takes a person's whole Q&A thread with it. Move the children onto
		// the surviving conversation first.
		if m.table == "recap_conversations" {
			if err := mergeRecapConversationChildren(ctx, tx, canonicalID, duplicateID); err != nil {
				return err
			}
		}
		conds := make([]string, 0, len(m.keyCols))
		for _, c := range m.keyCols {
			conds = append(conds, fmt.Sprintf("c.%[1]s = t.%[1]s", c))
		}
		// Identifiers come from the compile-time table above, never caller input,
		// so interpolating them cannot carry untrusted SQL.
		if _, err := tx.Exec(ctx, fmt.Sprintf(
			`UPDATE %[1]s t SET media_item_id = $1
			 WHERE t.media_item_id = $2
			   AND NOT EXISTS (
			     SELECT 1 FROM %[1]s c
			     WHERE c.media_item_id = $1 AND %[2]s
			   )`, m.table, strings.Join(conds, " AND ")), canonicalID, duplicateID); err != nil {
			return fmt.Errorf("reassign %s: %w", m.table, err)
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf(
			`DELETE FROM %s WHERE media_item_id = $1`, m.table), duplicateID); err != nil {
			return fmt.Errorf("drop colliding %s: %w", m.table, err)
		}
	}

	// Finally, delete the duplicate media item.
	_, err = tx.Exec(ctx, `DELETE FROM media_items WHERE id = $1`, duplicateID)
	if err != nil {
		return fmt.Errorf("delete dup media item: %w", err)
	}

	return tx.Commit(ctx)
}

// mergeRecapConversationChildren moves a duplicate conversation's turns and
// requests onto the canonical conversation for the same profile, so that the
// collision policy ("canonical wins") costs only the empty container and not the
// person's Q&A history.
//
// recap_conversations is not a per-profile opinion like a rating: it OWNS
// recap_conversation_turns and recap_conversation_requests, both ON DELETE
// CASCADE from its id. Dropping the duplicate's conversation therefore destroyed
// the thread, and the surviving canonical conversation could well be empty —
// confirmed by running it: 3 turns on the duplicate, 0 on the canonical, 0 after.
//
// Both children are UNIQUE (conversation_id, request_id), so a turn whose
// request_id the surviving conversation already has is genuinely the same turn
// and is left to cascade.
func mergeRecapConversationChildren(ctx context.Context, tx pgx.Tx, canonicalID, duplicateID int64) error {
	for _, table := range []string{"recap_conversation_turns", "recap_conversation_requests"} {
		if _, err := tx.Exec(ctx, fmt.Sprintf(
			`UPDATE %[1]s t SET conversation_id = canon.id
			 FROM recap_conversations dup
			 JOIN recap_conversations canon
			   ON canon.media_item_id = $1 AND canon.profile_id = dup.profile_id
			 WHERE dup.media_item_id = $2
			   AND t.conversation_id = dup.id
			   AND NOT EXISTS (
			     SELECT 1 FROM %[1]s c
			     WHERE c.conversation_id = canon.id AND c.request_id = t.request_id
			   )`, table), canonicalID, duplicateID); err != nil {
			return fmt.Errorf("move %s: %w", table, err)
		}
	}
	return nil
}

// mergeChildStrategy says how MergeMediaItems handles one ON DELETE CASCADE child
// of media_items.
type mergeChildStrategy struct {
	table string
	// keyCols is the table's unique key MINUS media_item_id, in FULL. It must be
	// complete: a partial key does not error, it silently decides that another
	// profile's or parent's row is a collision and deletes it. That mistake has
	// been made twice in this function — on recently_surfaced_items and on
	// watch_progress, where omitting profile_id destroyed a kid profile's watch
	// history. Empty means no unique index involves media_item_id, so every row
	// moves with a plain UPDATE and nothing is dropped.
	keyCols []string
	// keyPredicate mirrors a PARTIAL unique index's WHERE clause. watch_progress
	// is the only child with partial unique indexes, and it has two — which is
	// also why the schema guard must NOT filter on indpred IS NULL, as an earlier
	// version did, since that excluded the one table with the bug.
	//
	// It is documentation ONLY, and the generic loops REFUSE an entry that
	// declares one (see mergeChildStrategyError). That refusal is the point: the
	// loops do not apply the predicate, so a partial-keyed table added to the
	// generic path would get a collision check that ignores the index's WHERE
	// clause and would therefore delete another profile's row — exactly the
	// watch_progress bug, reintroduced. A review demonstrated that live. Both
	// current predicate-bearing entries are bespoke, with the condition
	// hand-written into their own SQL. If a generic table ever needs one, teach
	// the loops to apply it FIRST; failing loudly beats a silent wrong answer.
	keyPredicate string
	// bespoke marks children the hand-written walk earlier in MergeMediaItems
	// handles because they need more than a re-parent: the season/episode tree is
	// recursed, and watch_progress is re-pointed per episode. Their keyCols are
	// still declared here so the schema guard verifies them, but the generic loop
	// skips them.
	bespoke bool
	// episodeCol is the column referencing tv_episodes, for mergeEpisodeChildren
	// only. It is NOT uniform — most tables use episode_id but the recap tables
	// use up_to_episode_id — and assuming otherwise raised "column episode_id
	// does not exist" at runtime, caught by the behavioural test rather than by
	// the compiler. TestMergeMediaItemsCoversEveryEpisodeChild checks each value
	// against the actual foreign-key column in pg_constraint.
	episodeCol string
	why        string
}

// mergeChildren is every ON DELETE CASCADE child of media_items and what a merge
// owes it. The generic loop in MergeMediaItems iterates this, so adding an entry
// HANDLES the table rather than merely labelling it.
//
// TestMergeMediaItemsCoversEveryCascadeChild fails when the live schema has a
// cascade child this list lacks or vice versa;
// TestMergeMediaItemsKeyColumnsMatchTheSchema checks every keyCols/keyPredicate
// against pg_index; and TestMergeMediaItemsPreservesUserDataOnEveryChild derives
// its seed set from this list, so a new entry with no test row fails too.
//
// Only DIRECT children belong here. episode_files, for instance, cascades from
// tv_episodes rather than media_items: it is re-parented with its episode by the
// bespoke walk and is not this list's business. The guard reads the direct
// children out of pg_constraint and rejects anything else, which is how
// episode_files came off this list in the first place.
var mergeChildren = []mergeChildStrategy{
	// Bespoke: the catalog tree, and the progress and metadata hanging off it.
	{table: "media_files", bespoke: true, why: "re-parented: the playable files are the point of the merge"},
	{table: "tv_seasons", keyCols: []string{"season_number"}, bespoke: true, why: "re-parented: season tree is recursed"},
	{table: "tv_episodes", bespoke: true, why: "re-parented: walked with its season"},
	{table: "watch_progress", keyCols: []string{"user_id", "profile_id"}, keyPredicate: "episode_id IS NULL", bespoke: true, why: "re-parented per item and per episode: how far a person got"},
	{table: "artwork", keyCols: []string{"art_type", "source", "remote_path"}, bespoke: true, why: "re-parented: posters/backdrops"},
	{table: "media_cast", keyCols: []string{"person_id", "role_type", "character"}, bespoke: true, why: "re-parented: cast/crew"},
	{table: "media_genres", keyCols: []string{"genre_id"}, bespoke: true, why: "re-parented via ON CONFLICT DO NOTHING"},
	{table: "external_ids", keyCols: []string{"provider"}, bespoke: true, why: "re-parented via ON CONFLICT DO NOTHING"},

	// Generic, collision-checked: what a person or an admin created.
	{table: "watchlist_items", keyCols: []string{"watchlist_id"}, why: "a person put this on a list"},
	{table: "collection_items", keyCols: []string{"collection_id"}, why: "an admin curated this collection"},
	{table: "user_ratings", keyCols: []string{"profile_id"}, why: "a person's own star rating"},
	{table: "item_feedback", keyCols: []string{"profile_id"}, why: "a person's like/dislike signal"},
	{table: "taste_seeds", keyCols: []string{"profile_id"}, why: "onboarding taste picks feed the recommender"},
	{table: "recently_surfaced_items", keyCols: []string{"profile_id", "surface"}, why: "suppresses re-showing the same title"},
	// Also cascades from tv_episodes, so recaps on a duplicate episode the
	// canonical already had are gone with that episode before this runs — inherent
	// to collapsing two episode rows into one.
	{table: "episode_recaps", keyCols: []string{"up_to_episode_id"}, why: "generated recaps cost LLM calls to rebuild"},
	{table: "recap_conversations", keyCols: []string{"profile_id"}, why: "a person's recap Q&A thread; its turns are moved first"},

	// Generic, no collision possible: media_item_id is in no unique index.
	{table: "watch_parties", why: "re-parented: may be a LIVE room with participants in it"},
	{table: "recommendation_impressions", why: "re-parented: recommender training/telemetry history"},
	{table: "recommendation_watch_events", why: "re-parented: recommender outcome history"},
}

// mergeEpisodeChildren is every child of tv_episodes that must be re-pointed when
// the merge collapses a duplicate episode into the canonical one, together with
// what happens if it is not.
//
// The cascades lose the row outright; the SET NULLs are worse than they look. An
// active watch party silently became a show with NO episode, and
// internal/watchparty/rehydrate.go reads EpisodeID straight off that row at boot
// — routine here, because the box auto-deploys.
//
// TestMergeMediaItemsCoversEveryEpisodeChild keys this off pg_constraint the same
// way mergeChildren is keyed, so a new child of tv_episodes cannot drift in either.
var mergeEpisodeChildren = []mergeChildStrategy{
	{table: "episode_files", episodeCol: "episode_id", bespoke: true, why: "moved by the walk before the dup episode is deleted (CASCADE)"},
	{table: "watch_progress", episodeCol: "episode_id", keyCols: []string{"user_id", "profile_id"}, keyPredicate: "episode_id IS NOT NULL", bespoke: true, why: "moved by the walk, per episode (CASCADE)"},
	// Plain UPDATE, deliberately. Its key is (media_item_id, up_to_episode_id) and
	// at this point the row's media_item_id is still the DUPLICATE's, so a
	// collision check here could only ever compare the row against itself — a
	// no-op that read like protection (a review caught it). The re-point cannot
	// collide anyway: the target (duplicateID, canonEpID) is necessarily free,
	// because canonEpID belongs to the canonical item. The genuine collision,
	// against the canonical's own recap for that episode, is resolved by the
	// mergeChildren pass afterwards, which is keyed correctly.
	{table: "episode_recaps", episodeCol: "up_to_episode_id", why: "re-pointed; CASCADE would drop the generated recap"},
	{table: "recommendation_watch_events", episodeCol: "episode_id", why: "re-pointed; CASCADE would drop the outcome history"},
	{table: "watch_parties", episodeCol: "episode_id", why: "re-pointed; SET NULL would leave a live party on no episode"},
	{table: "recap_conversation_turns", episodeCol: "up_to_episode_id", why: "re-pointed; SET NULL would lose which episode the turn was about"},
}

// mergeChildStrategyError reports a spec entry the generic loops cannot honour.
// Called at the top of MergeMediaItems so a bad entry fails the first merge
// loudly instead of quietly destroying rows.
//
// The refused shape is a non-bespoke entry carrying a keyPredicate: the loops
// build their collision check from keyCols alone, so the partial index's WHERE
// clause would be ignored and rows outside it treated as collisions and deleted.
// TestMergeChildrenSpecIsHonourable pins the same rule statically.
func mergeChildStrategyError(specs ...[]mergeChildStrategy) error {
	for _, list := range specs {
		for _, m := range list {
			if m.bespoke || m.keyPredicate == "" {
				continue
			}
			return fmt.Errorf(
				"merge child %q declares keyPredicate %q but is not bespoke: the generic loop does not apply predicates, so its collision check would ignore the partial index and delete rows it does not cover",
				m.table, m.keyPredicate)
		}
	}
	return nil
}

// repointEpisodeChildren moves the non-bespoke children of a duplicate episode
// onto the canonical episode, before the duplicate episode is deleted.
func repointEpisodeChildren(ctx context.Context, tx pgx.Tx, canonEpID, dupEpID int64) error {
	for _, m := range mergeEpisodeChildren {
		if m.bespoke {
			continue
		}
		if m.episodeCol == "" {
			return fmt.Errorf("mergeEpisodeChildren entry %q declares no episodeCol", m.table)
		}
		if len(m.keyCols) == 0 {
			if _, err := tx.Exec(ctx, fmt.Sprintf(
				`UPDATE %[1]s SET %[2]s = $1 WHERE %[2]s = $2`, m.table, m.episodeCol),
				canonEpID, dupEpID); err != nil {
				return fmt.Errorf("re-point %s: %w", m.table, err)
			}
			continue
		}
		conds := make([]string, 0, len(m.keyCols))
		for _, c := range m.keyCols {
			conds = append(conds, fmt.Sprintf("c.%[1]s = t.%[1]s", c))
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf(
			`UPDATE %[1]s t SET %[2]s = $1
			 WHERE t.%[2]s = $2
			   AND NOT EXISTS (
			     SELECT 1 FROM %[1]s c
			     WHERE c.%[2]s = $1 AND %[3]s
			   )`, m.table, m.episodeCol, strings.Join(conds, " AND ")), canonEpID, dupEpID); err != nil {
			return fmt.Errorf("re-point %s: %w", m.table, err)
		}
	}
	return nil
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

// metadataProgressExpr is when an item last made metadata PROGRESS: the more
// recent of "metadata was stored" (last_metadata) and "a provider was asked and
// answered" (last_metadata_attempt, migration 059). Postgres GREATEST ignores
// NULL operands and yields NULL only when every operand is NULL, so this is
// NULL for exactly the never-touched items — which is what puts them at the
// head of the queue under NULLS FIRST.
//
// Both the WHERE and the ORDER BY of GetStaleMetadataItems read this one
// expression, as does FindMediaItemByTitle's Attempted flag, so the scanner and
// the refresh queue cannot disagree about what "already dealt with" means.
//
// Sharing this constant with a test does NOT pin that the production query uses
// it — a test that builds its own predicate from the constant stays green when
// the query body is changed to something else, which is the "a case must fail
// for the RIGHT reason" trap from the check-library-paths post-mortem. The
// rotation is therefore pinned end-to-end, through GetStaleMetadataItems itself,
// by TestGetStaleMetadataItemsRotatesPastAttemptedItems.
const metadataProgressExpr = `GREATEST(last_metadata, last_metadata_attempt)`

// GetStaleMetadataItems returns items whose metadata is older than maxAge or was never fetched.
//
// Ordering and selection go through metadataProgressExpr rather than
// last_metadata alone. Ordering on last_metadata meant an item no provider has
// an entry for — last_metadata NULL for ever, because UpdateMediaMetadata is
// never reached for it — held a permanent place at the head of a
// NULLS-FIRST-ordered LIMIT 100. Once a library accumulated 100 such items the
// refresh pass re-read the same 100 on every tick and no other item in the
// catalog was ever refreshed again. Counting the ATTEMPT as progress lets those
// items fall back into the normal maxAge rotation.
//
// Every nullable column in the projection is COALESCEd. media_items.year,
// overview, rating, runtime_minutes and content_rating are all nullable, while
// the models.MediaItem fields they land in are plain int/string/float64 — so a
// single row with any one of them NULL failed the whole query ("cannot scan NULL
// into *int") and RefreshStaleMetadata returned an error having enriched
// NOTHING. Because un-enriched rows sort FIRST here, one such row at the head of
// the queue disabled metadata refresh for the entire catalog, permanently and
// silently.
//
// No current application write path produces those NULLs — UpsertMediaItem
// inserts the Go zero values (0 / "") and UpdateMediaMetadata only ever sets
// fields it has values for — so this is latent robustness rather than the proven
// cause of #510. It stops being latent as soon as anyone touches the catalog
// with hand-written SQL, which this repo's own runbooks prescribe
// (docs/moving-media-paths.md) and which is exactly how #510 was remediated.
// The zero values are already the codebase's "unknown" sentinels for these
// fields (all are omitempty, and the enricher writes year back via nilIfZero).
func (q *Queries) GetStaleMetadataItems(ctx context.Context, maxAge time.Duration) ([]*models.StaleMediaItem, error) {
	cutoff := time.Now().Add(-maxAge)
	rows, err := q.pool.Query(ctx, `
		SELECT id, library_id, type, title, sort_title,
		       COALESCE(year, 0), COALESCE(overview, ''), COALESCE(rating, 0),
		       COALESCE(runtime_minutes, 0), COALESCE(content_rating, ''),
		       added_at, updated_at, tmdb_id, last_metadata
		FROM media_items
		WHERE `+metadataProgressExpr+` IS NULL OR `+metadataProgressExpr+` < $1
		ORDER BY `+metadataProgressExpr+` ASC NULLS FIRST, id ASC
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

// UnattemptedShow is a show whose enrichment has never been attempted, together
// with one of its episode file paths so the caller can still find a sibling .nfo.
type UnattemptedShow struct {
	Item     *models.MediaItem
	FilePath string
}

// GetUnattemptedShowsForLibrary returns the library's shows that have made no
// metadata progress at all — neither stored nor attempted — and that still have
// at least one episode file on record.
//
// This exists because the scanner's per-file path could not reach them. processFile
// returns early when a file's hash is unchanged, BEFORE it consults
// FindMediaItemByTitle, and the #510 state is precisely "every episode file was
// recorded and flushed, then the deferred enrichment pass was cancelled" — so on
// the next scan every file is unchanged and the enrichment latch is never
// evaluated. The latch was therefore unreachable in the exact state it was written
// for unless the show happened to gain a new or modified file. A round-5 review
// caught that; ScanLibrary now asks this question once per scan instead.
//
// The EXISTS clause matters: a show with no files left is about to be swept by
// DeleteEmptyMediaItems, and enriching it would spend provider calls on a row
// that is being deleted.
func (q *Queries) GetUnattemptedShowsForLibrary(ctx context.Context, libraryID int64) ([]UnattemptedShow, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT mi.id, mi.library_id, mi.type, mi.title, mi.sort_title, COALESCE(mi.year, 0),
		       COALESCE((
		         SELECT ef.path FROM episode_files ef
		         JOIN tv_episodes te ON te.id = ef.episode_id
		         WHERE te.media_item_id = mi.id
		         ORDER BY ef.id LIMIT 1
		       ), '')
		FROM media_items mi
		WHERE mi.library_id = $1
		  AND mi.type = 'show'
		  AND `+metadataProgressExpr2("mi")+` IS NULL
		  AND EXISTS (
		    SELECT 1 FROM tv_episodes te
		    JOIN episode_files ef ON ef.episode_id = te.id
		    WHERE te.media_item_id = mi.id
		  )
		ORDER BY mi.id`, libraryID)
	if err != nil {
		return nil, fmt.Errorf("get unattempted shows: %w", err)
	}
	defer rows.Close()

	var out []UnattemptedShow
	for rows.Next() {
		item := &models.MediaItem{}
		var path string
		if err := rows.Scan(&item.ID, &item.LibraryID, &item.Type, &item.Title,
			&item.SortTitle, &item.Year, &path); err != nil {
			return nil, fmt.Errorf("scan unattempted show: %w", err)
		}
		out = append(out, UnattemptedShow{Item: item, FilePath: path})
	}
	return out, rows.Err()
}

// metadataProgressExpr2 qualifies metadataProgressExpr with a table alias, for
// queries that join. Kept as a helper so there is still exactly one definition of
// "has this row made metadata progress".
func metadataProgressExpr2(alias string) string {
	return fmt.Sprintf("GREATEST(%[1]s.last_metadata, %[1]s.last_metadata_attempt)", alias)
}

// TouchLastMetadata bumps the last_metadata timestamp for an item without changing any data.
// Used by smart diffing when TMDB reports no changes since last fetch.
func (q *Queries) TouchLastMetadata(ctx context.Context, mediaItemID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE media_items SET last_metadata = NOW() WHERE id = $1`, mediaItemID)
	return err
}

// TouchMetadataAttempt records that a provider was asked about this item and
// answered, whether or not the answer contained a usable match.
//
// It deliberately does NOT touch last_metadata: that column means "metadata was
// stored", and RefreshStaleMetadata's smart diffing hands it to TMDB's changes
// API, which is only meaningful for an item that really was matched. The two
// facts are combined at read time by metadataProgressExpr.
//
// Only the SEARCH-based path (Enricher.EnrichMediaItem) stamps this. A failure
// to reach the provider at all must NOT be recorded as an attempt, or one TMDB
// outage during a scan would defer every item it touched by a full refresh
// interval.
//
// Updates zero rows, without error, when the item has just been merged away by
// handleDuplicateMetadata — the canonical row survives carrying its own
// last_metadata, so nothing is owed. That is the same no-op the SetMatchStatus
// calls beside the stamp have always performed on that path.
//
// The one case where it is not harmless: handleDuplicateMetadata swallows a
// FAILED MergeMediaItems and still reports the duplicate as handled, so the
// surviving row gets stamped attempted with nothing stored. The scanner's latch
// then leaves it alone permanently and only the refresh rotation can reach it.
// Pre-existing stranding, newly reachable now that the latch consults attempts;
// recorded in CLAUDE.md's known limits.
func (q *Queries) TouchMetadataAttempt(ctx context.Context, mediaItemID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE media_items SET last_metadata_attempt = NOW() WHERE id = $1`, mediaItemID)
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
		       COALESCE(vote_average, 0), is_primary, COALESCE(blurhash, ''), cached_at, created_at
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
	// Co-fetches the canonical season_id for (media, season_number) so
	// we can sanity-check that every episode row's season_id matches.
	// If we ever see episodes attached to a season_id that doesn't
	// match the requested season_number, the seasons table has drifted
	// from the episodes table — log it loudly so the data corruption
	// can be diagnosed. This is the defensive guard for the QA report
	// that "S1 and S2 of a multi-season show return the same titles":
	// without this log, the bug shows up as a UX symptom with no trail
	// back to the inconsistent data.
	var canonicalSeasonID int64
	if err := q.pool.QueryRow(ctx,
		`SELECT id FROM tv_seasons WHERE media_item_id = $1 AND season_number = $2`,
		mediaItemID, seasonNum,
	).Scan(&canonicalSeasonID); err != nil {
		// Not an error — the show simply may not have this season.
		// The downstream JOIN-based query will return zero rows in
		// that case, which is the right behavior.
		canonicalSeasonID = 0
	}

	// Critical: the JOIN to tv_seasons must also constrain on
	// s.media_item_id, NOT just e.media_item_id. Without that extra
	// predicate, an episode row whose season_id points at a different
	// show's season (data corruption: scanner race, manual edit, or
	// an importer regression) would leak into the result set as long
	// as both shows happen to have a season N. The unique index is
	// UNIQUE(season_id, episode_number) — it does NOT prevent an
	// episode-row from being attached to the wrong show's season.
	//
	// This is the candidate root cause of the QA "S1 and S2 return
	// the same episode titles" bug. Tightening the JOIN here means
	// the defensive log below should never fire for a clean DB; if
	// it does, the WARN identifies exactly which row drifted.
	rows, err := q.pool.Query(ctx, `
		SELECT e.id, e.season_id, e.media_item_id, e.episode_number,
		       COALESCE(e.title, ''), COALESCE(e.overview, ''),
		       COALESCE(e.runtime_minutes, 0), e.air_date,
		       COALESCE(e.still_path, '')
		FROM tv_episodes e
		JOIN tv_seasons s ON s.id = e.season_id AND s.media_item_id = e.media_item_id
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
		// Defensive: warn if an episode came back with a season_id
		// that does NOT match the canonical (media, season_number)
		// row. The JOIN should prevent this, but a future schema
		// change or unique-constraint regression could let it slip.
		if canonicalSeasonID != 0 && ep.SeasonID != canonicalSeasonID {
			slog.Warn("episode season_id mismatch — data may be corrupt",
				"media_item_id", mediaItemID,
				"requested_season", seasonNum,
				"canonical_season_id", canonicalSeasonID,
				"episode_id", ep.ID,
				"episode_season_id", ep.SeasonID,
				"episode_number", ep.Number,
				"episode_title", ep.Title)
		}
		episodes = append(episodes, ep)
	}
	return episodes, rows.Err()
}

// GetEpisodeFiles returns all files for a specific episode.
func (q *Queries) GetEpisodeFiles(ctx context.Context, episodeID int64) ([]*models.EpisodeFile, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT id, episode_id, path, size_bytes, COALESCE(container, ''), COALESCE(video_codec, ''), COALESCE(audio_codec, ''),
		       COALESCE(resolution, ''), COALESCE(bitrate, 0), COALESCE(duration_ms, 0),
		       file_hash, scanned_at, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt, color_transfer, color_primaries, video_fps
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
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt, &f.ColorTransfer, &f.ColorPrimaries, &f.VideoFPS); err != nil {
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
//
// Returns newlyCompleted=true iff THIS call caused the row to transition into
// completed=true for the first time (a fresh INSERT that lands completed, or an
// UPDATE that flips a previously-incomplete row to completed). Repeat calls on an
// already-completed row return false. Callers use this to make one-time side
// effects — gamification XP/achievement grants — idempotent: completing a title
// awards exactly once, and replaying the endpoint awards nothing (security low:
// MarkWatched XP/achievement farming).
func (q *Queries) UpsertWatchProgress(ctx context.Context, p *models.WatchProgress) (newlyCompleted bool, err error) {
	// Read completion threshold from DB settings; fall back to 0.90 if unset or invalid.
	threshold := 0.90
	if raw, gErr := q.GetSetting(ctx, "completion_threshold"); gErr != nil {
		slog.Warn("failed to read completion_threshold setting, using default", "error", gErr)
	} else if raw != "" {
		if parsed, pErr := strconv.ParseFloat(raw, 64); pErr == nil && parsed >= 0 && parsed <= 1 {
			threshold = parsed
		}
	}

	// Auto-complete when position reaches the configured threshold
	if p.DurationMs > 0 && float64(p.PositionMs)/float64(p.DurationMs) >= threshold {
		p.Completed = true
	}

	// Convert zero ProfileID to nil for nullable DB column
	resolvedProfileID := p.ProfileID
	if resolvedProfileID <= 0 {
		if err := q.pool.QueryRow(ctx, `
			SELECT id FROM user_profiles
			WHERE user_id=$1 AND is_default=TRUE
			LIMIT 1`, p.UserID).Scan(&resolvedProfileID); err != nil {
			return false, fmt.Errorf("resolve watch progress profile: %w", err)
		}
	}
	var profileID interface{} = resolvedProfileID

	// Transition detection and its immutable event must observe one serial
	// history per playback row. A transaction-scoped advisory lock is taken
	// before the statement obtains its snapshot, preventing concurrent
	// heartbeats from emitting the same transition twice.
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin watch progress upsert: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after Commit
	lockKey := fmt.Sprintf("watch-progress:%d:%d:%d", p.UserID, p.MediaItemID, resolvedProfileID)
	if p.EpisodeID != nil {
		lockKey = fmt.Sprintf("watch-progress:%d:episode:%d:%d", p.UserID, *p.EpisodeID, resolvedProfileID)
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		return false, fmt.Errorf("lock watch progress: %w", err)
	}

	// The CTE captures the row's PRIOR completed state (before the upsert) so we
	// can report newly_completed = (new completed AND NOT previously completed).
	// `prior` is empty on a first INSERT, so COALESCE(prior.completed, FALSE) is
	// FALSE and newly_completed collapses to the incoming completed flag. We can't
	// use RETURNING (xmax=0) here because an UPDATE that flips completed must also
	// count — only a re-update of an already-completed row must be suppressed.
	if p.EpisodeID != nil {
		err = tx.QueryRow(ctx, `
			WITH prior AS (
			    SELECT completed, position_ms, duration_ms FROM watch_progress
			    WHERE user_id = $1 AND episode_id = $3
			      AND profile_id = COALESCE($7, (SELECT id FROM user_profiles WHERE user_id = $1 AND is_default = TRUE LIMIT 1))
			),
			upsert AS (
			    INSERT INTO watch_progress (user_id, media_item_id, episode_id, position_ms, duration_ms, completed, completed_at, profile_id)
			    VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN NOW() ELSE NULL END, COALESCE($7, (SELECT id FROM user_profiles WHERE user_id = $1 AND is_default = TRUE LIMIT 1)))
			    ON CONFLICT (user_id, profile_id, episode_id) WHERE episode_id IS NOT NULL
			    DO UPDATE SET position_ms = EXCLUDED.position_ms,
			                 duration_ms = COALESCE(NULLIF(EXCLUDED.duration_ms, 0), watch_progress.duration_ms),
			                 completed = (watch_progress.completed OR EXCLUDED.completed),
			                 completed_at = CASE WHEN EXCLUDED.completed AND NOT watch_progress.completed THEN NOW() ELSE watch_progress.completed_at END,
			                 updated_at = NOW()
			    RETURNING completed
			), event_insert AS (
			    INSERT INTO recommendation_watch_events
			      (profile_id, media_item_id, episode_id, event_type, progress)
			    SELECT COALESCE($7, (SELECT id FROM user_profiles WHERE user_id=$1 AND is_default=TRUE LIMIT 1)),
			           $2, $3,
			           CASE
			             WHEN $6 AND COALESCE((SELECT completed FROM prior), FALSE) THEN 'rewatch_completed'
			             WHEN $6 THEN 'completed'
			             WHEN $5 > 0 AND $4::float8/$5::float8 < 0.20 THEN 'started'
			             ELSE 'engaged'
			           END,
			           CASE WHEN $5 > 0 THEN LEAST(1.0, GREATEST(0.0, $4::float8/$5::float8))
			                WHEN $6 THEN 1.0 ELSE 0.0 END
			    WHERE ($6 AND NOT COALESCE((SELECT completed FROM prior), FALSE))
			       OR ($6 AND COALESCE((SELECT completed FROM prior), FALSE)
			              AND COALESCE((SELECT duration_ms FROM prior), 0) > 0
			              AND COALESCE((SELECT position_ms::float8/NULLIF(duration_ms,0) FROM prior), 0) < 0.90)
			       OR (NOT $6 AND $5 > 0 AND $4::float8/$5::float8 >= 0.20
			              AND COALESCE((SELECT position_ms::float8/NULLIF(duration_ms,0) FROM prior), 0) < 0.20)
			       OR (NOT $6 AND $5 > 0 AND $4 > 0 AND $4::float8/$5::float8 < 0.20
			              AND (NOT EXISTS (SELECT 1 FROM prior) OR $4 < (SELECT position_ms FROM prior)
			                   OR NOT EXISTS (
			                     SELECT 1 FROM recommendation_watch_events recent
			                     WHERE recent.profile_id=COALESCE($7, (SELECT id FROM user_profiles WHERE user_id=$1 AND is_default=TRUE LIMIT 1))
			                       AND recent.media_item_id=$2 AND recent.episode_id=$3
			                       AND recent.event_type='started' AND recent.occurred_at > NOW()-INTERVAL '5 minutes'
			                   )))
			)
			SELECT upsert.completed AND NOT COALESCE((SELECT completed FROM prior), FALSE)
			FROM upsert`,
			p.UserID, p.MediaItemID, p.EpisodeID, p.PositionMs, p.DurationMs, p.Completed, profileID).Scan(&newlyCompleted)
		if err != nil {
			return false, err
		}
		if err = tx.Commit(ctx); err != nil {
			return false, fmt.Errorf("commit watch progress: %w", err)
		}
		return newlyCompleted, nil
	}

	err = tx.QueryRow(ctx, `
	WITH prior AS (
	    SELECT completed, position_ms, duration_ms FROM watch_progress
		    WHERE user_id = $1 AND media_item_id = $2 AND episode_id IS NULL
		      AND profile_id = COALESCE($6, (SELECT id FROM user_profiles WHERE user_id = $1 AND is_default = TRUE LIMIT 1))
		),
		upsert AS (
		    INSERT INTO watch_progress (user_id, media_item_id, position_ms, duration_ms, completed, completed_at, profile_id)
		    VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 THEN NOW() ELSE NULL END, COALESCE($6, (SELECT id FROM user_profiles WHERE user_id = $1 AND is_default = TRUE LIMIT 1)))
		    ON CONFLICT (user_id, profile_id, media_item_id) WHERE episode_id IS NULL
		    DO UPDATE SET position_ms = EXCLUDED.position_ms,
			                 duration_ms = COALESCE(NULLIF(EXCLUDED.duration_ms, 0), watch_progress.duration_ms),
		                 completed = (watch_progress.completed OR EXCLUDED.completed),
		                 completed_at = CASE WHEN EXCLUDED.completed AND NOT watch_progress.completed THEN NOW() ELSE watch_progress.completed_at END,
		                 updated_at = NOW()
	    RETURNING completed
	), event_insert AS (
	    INSERT INTO recommendation_watch_events
	      (profile_id, media_item_id, episode_id, event_type, progress)
	    SELECT COALESCE($6, (SELECT id FROM user_profiles WHERE user_id=$1 AND is_default=TRUE LIMIT 1)),
	           $2, NULL,
	           CASE
	             WHEN $5 AND COALESCE((SELECT completed FROM prior), FALSE) THEN 'rewatch_completed'
	             WHEN $5 THEN 'completed'
	             WHEN $4 > 0 AND $3::float8/$4::float8 < 0.20 THEN 'started'
	             ELSE 'engaged'
	           END,
	           CASE WHEN $4 > 0 THEN LEAST(1.0, GREATEST(0.0, $3::float8/$4::float8))
	                WHEN $5 THEN 1.0 ELSE 0.0 END
	    WHERE ($5 AND NOT COALESCE((SELECT completed FROM prior), FALSE))
	       OR ($5 AND COALESCE((SELECT completed FROM prior), FALSE)
	              AND COALESCE((SELECT duration_ms FROM prior), 0) > 0
	              AND COALESCE((SELECT position_ms::float8/NULLIF(duration_ms,0) FROM prior), 0) < 0.90)
	       OR (NOT $5 AND $4 > 0 AND $3::float8/$4::float8 >= 0.20
	              AND COALESCE((SELECT position_ms::float8/NULLIF(duration_ms,0) FROM prior), 0) < 0.20)
	       OR (NOT $5 AND $4 > 0 AND $3 > 0 AND $3::float8/$4::float8 < 0.20
	              AND (NOT EXISTS (SELECT 1 FROM prior) OR $3 < (SELECT position_ms FROM prior)
	                   OR NOT EXISTS (
	                     SELECT 1 FROM recommendation_watch_events recent
	                     WHERE recent.profile_id=COALESCE($6, (SELECT id FROM user_profiles WHERE user_id=$1 AND is_default=TRUE LIMIT 1))
	                       AND recent.media_item_id=$2 AND recent.episode_id IS NULL
	                       AND recent.event_type='started' AND recent.occurred_at > NOW()-INTERVAL '5 minutes'
	                   )))
	)
		SELECT upsert.completed AND NOT COALESCE((SELECT completed FROM prior), FALSE)
		FROM upsert`,
		p.UserID, p.MediaItemID, p.PositionMs, p.DurationMs, p.Completed, profileID).Scan(&newlyCompleted)
	if err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit watch progress: %w", err)
	}
	return newlyCompleted, nil
}

// GetWatchProgress returns progress for a specific item/episode, scoped to the
// user's DEFAULT profile. Deferred follow-up (deep-debug B, non-blocking): make
// this read + DeleteWatchProgress honor an explicit non-default profile, gated
// on multi-profile UI. Today no client sends an explicit profile, so writes
// (via resolveProgressProfileID) and reads/deletes all consistently resolve to
// the default profile — the asymmetry is dormant until profile-switching ships.
func (q *Queries) GetWatchProgress(ctx context.Context, userID, mediaItemID int64, episodeID *int64) (*models.WatchProgress, error) {
	var wp models.WatchProgress
	var err error

	var profileID *int64
	if episodeID != nil {
		err = q.pool.QueryRow(ctx, `
			SELECT id, user_id, media_item_id, episode_id, position_ms, duration_ms, completed, updated_at, profile_id
			FROM watch_progress WHERE user_id = $1 AND episode_id = $2
			  AND profile_id = (SELECT id FROM user_profiles WHERE user_id = $1 AND is_default = TRUE LIMIT 1)`,
			userID, *episodeID).Scan(&wp.ID, &wp.UserID, &wp.MediaItemID, &wp.EpisodeID,
			&wp.PositionMs, &wp.DurationMs, &wp.Completed, &wp.UpdatedAt, &profileID)
	} else {
		err = q.pool.QueryRow(ctx, `
			SELECT id, user_id, media_item_id, episode_id, position_ms, duration_ms, completed, updated_at, profile_id
			FROM watch_progress WHERE user_id = $1 AND media_item_id = $2 AND episode_id IS NULL
			  AND profile_id = (SELECT id FROM user_profiles WHERE user_id = $1 AND is_default = TRUE LIMIT 1)`,
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

// GetContinueWatching returns in-progress items for the "Continue
// Watching" row, deduplicated to one entry per show (or movie).
//
// QA finding follow-up — previously each in-progress episode of a TV
// show rendered as its own card, so "Drake & Josh S1E1" and "Drake &
// Josh S1E2" both appeared on Library/Home. The DISTINCT ON wrapper
// rolls those up to a single most-recent row per media_item (the
// show), so the user sees one Drake & Josh card whose
// episode-specific fields (season/episode/episode_title) describe
// where they left off.
//
// Movies are unaffected — one media_item per movie means DISTINCT ON
// is a no-op for them.
func (q *Queries) GetContinueWatching(ctx context.Context, userID int64, limit int) ([]models.ContinueWatchingItem, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	// DISTINCT ON requires the ORDER BY to lead with the same column;
	// the outer wrapper re-orders by updated_at DESC for the actual
	// display order.
	rows, err := q.pool.Query(ctx, `
		SELECT id, user_id, profile_id, media_item_id, episode_id,
		       position_ms, duration_ms, completed, updated_at,
		       title, poster_path, backdrop_path, type, year, rating,
		       episode_title, season_number, episode_number
		FROM (
		  SELECT DISTINCT ON (wp.media_item_id)
		         wp.id, wp.user_id, COALESCE(wp.profile_id, 0) AS profile_id, wp.media_item_id, wp.episode_id,
		         wp.position_ms, wp.duration_ms, wp.completed, wp.updated_at,
		         mi.title, COALESCE(mi.poster_path, '') AS poster_path, COALESCE(mi.backdrop_path, '') AS backdrop_path, mi.type,
		         COALESCE(mi.year, 0) AS year,
		         COALESCE(mi.rating, 0) AS rating,
		         COALESCE(e.title, '') AS episode_title,
		         s.season_number, e.episode_number
		  FROM watch_progress wp
		  JOIN media_items mi ON mi.id = wp.media_item_id
		  LEFT JOIN tv_episodes e ON e.id = wp.episode_id
		  LEFT JOIN tv_seasons s ON s.id = e.season_id
		  WHERE wp.user_id = $1 AND wp.completed = FALSE AND wp.position_ms > 0
		  ORDER BY wp.media_item_id, wp.updated_at DESC
		) dedup
		ORDER BY updated_at DESC
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

	// Same DISTINCT ON dedup as GetContinueWatching above — see that
	// comment for the rationale.
	rows, err := q.pool.Query(ctx, `
		SELECT id, user_id, profile_id, media_item_id, episode_id,
		       position_ms, duration_ms, completed, updated_at,
		       title, poster_path, backdrop_path, type, year, rating,
		       episode_title, season_number, episode_number
		FROM (
		  SELECT DISTINCT ON (wp.media_item_id)
		         wp.id, wp.user_id, COALESCE(wp.profile_id, 0) AS profile_id, wp.media_item_id, wp.episode_id,
		         wp.position_ms, wp.duration_ms, wp.completed, wp.updated_at,
		         mi.title, COALESCE(mi.poster_path, '') AS poster_path, COALESCE(mi.backdrop_path, '') AS backdrop_path, mi.type,
		         COALESCE(mi.year, 0) AS year,
		         COALESCE(mi.rating, 0) AS rating,
		         COALESCE(e.title, '') AS episode_title,
		         s.season_number, e.episode_number
		  FROM watch_progress wp
		  JOIN media_items mi ON mi.id = wp.media_item_id
		  LEFT JOIN tv_episodes e ON e.id = wp.episode_id
		  LEFT JOIN tv_seasons s ON s.id = e.season_id
		  WHERE wp.profile_id = $1 AND wp.completed = FALSE AND wp.position_ms > 0
		  ORDER BY wp.media_item_id, wp.updated_at DESC
		) dedup
		ORDER BY updated_at DESC
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

// ListGenres returns the distinct genre names present in the library,
// optionally narrowed to a single media type (e.g. "movie" or "show").
// An empty mediaType returns every genre referenced by any media item.
// Sorted alphabetically. Used by the browse-page dropdown so the genre
// list is stable across pagination/sort changes.
//
// Only genres that have at least one matching item are returned —
// orphan rows in the genres table (no media_genres references) are
// excluded so the dropdown never offers a filter that returns zero
// results.
func (q *Queries) ListGenres(ctx context.Context, mediaType string) ([]string, error) {
	var (
		rows pgx.Rows
		err  error
	)
	if mediaType == "" {
		rows, err = q.pool.Query(ctx, `
			SELECT DISTINCT g.name
			FROM genres g
			JOIN media_genres mg ON mg.genre_id = g.id
			ORDER BY g.name`)
	} else {
		rows, err = q.pool.Query(ctx, `
			SELECT DISTINCT g.name
			FROM genres g
			JOIN media_genres mg ON mg.genre_id = g.id
			JOIN media_items m  ON m.id = mg.media_item_id
			WHERE m.type = $1
			ORDER BY g.name`, mediaType)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	return names, rows.Err()
}

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
//
// The five nullable columns are COALESCEd for the same reason as everywhere else
// in this package: they land in non-nullable models.MediaItem fields, so one NULL
// fails the whole query. This one is reachable — MetadataHandler.GetEnriched calls
// it on any authenticated request and returns a bare 500 — and it sits directly
// beside GetMediaItem, which was fixed first. A round-5 review found it after six
// others had been done, which is the "assume adjacent, not novel" lesson again.
func (q *Queries) GetMediaItemEnriched(ctx context.Context, id int64) (*models.MediaItemEnriched, error) {
	row := q.pool.QueryRow(ctx, `
		SELECT id, library_id, type, title, sort_title,
		       COALESCE(year, 0), COALESCE(overview, ''), COALESCE(rating, 0),
		       COALESCE(runtime_minutes, 0), COALESCE(content_rating, ''),
		       added_at, updated_at,
		       tmdb_id, COALESCE(imdb_id, ''), COALESCE(tagline, ''),
		       COALESCE(poster_path, ''), COALESCE(backdrop_path, ''),
		       COALESCE(studio, ''), COALESCE(network, ''), COALESCE(release_date, ''),
		       trailer_key
		FROM media_items WHERE id = $1`, id)

	item := &models.MediaItem{}
	enriched := &models.MediaItemEnriched{MediaItem: item}

	// trailer_key is read raw (nullable): NULL → not yet checked, so
	// TrailerChecked stays false and GetEnriched backfills it; non-NULL (a key
	// or "") → already checked.
	var trailerKey *string
	err := row.Scan(&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
		&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin, &item.ContentRating,
		&item.AddedAt, &item.UpdatedAt,
		&enriched.TMDBID, &enriched.IMDbID, &enriched.Tagline,
		&item.PosterPath, &item.BackdropPath,
		&item.Studio, &item.Network, &item.ReleaseDate, &trailerKey)
	if err != nil {
		return nil, err
	}
	if trailerKey != nil {
		enriched.TrailerKey = *trailerKey
		enriched.TrailerChecked = true
	}

	return enriched, nil
}

// SetTrailerKey persists the resolved trailer key for an item: the YouTube id,
// or "" for "checked, no trailer". Used by the lazy backfill in GetEnriched.
func (q *Queries) SetTrailerKey(ctx context.Context, id int64, key string) error {
	_, err := q.pool.Exec(ctx, `UPDATE media_items SET trailer_key = $2 WHERE id = $1`, id, key)
	return err
}

// GetMediaFileByID returns a media file by its primary key.
func (q *Queries) GetMediaFileByID(ctx context.Context, id int64) (*models.MediaFile, error) {
	f := &models.MediaFile{}
	var audioJSON, subtitleJSON []byte
	err := q.pool.QueryRow(ctx, `
		SELECT id, media_item_id, path, size_bytes, COALESCE(container, ''), COALESCE(video_codec, ''), COALESCE(audio_codec, ''),
		       COALESCE(resolution, ''), COALESCE(bitrate, 0), COALESCE(duration_ms, 0),
		       file_hash, scanned_at, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt, color_transfer, color_primaries, video_fps
		FROM media_files WHERE id = $1`, id).
		Scan(&f.ID, &f.MediaItemID, &f.Path, &f.SizeBytes, &f.Container,
			&f.VideoCodec, &f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs,
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt, &f.ColorTransfer, &f.ColorPrimaries, &f.VideoFPS)
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
		SELECT id, episode_id, path, size_bytes, COALESCE(container, ''), COALESCE(video_codec, ''), COALESCE(audio_codec, ''),
		       COALESCE(resolution, ''), COALESCE(bitrate, 0), COALESCE(duration_ms, 0),
		       file_hash, scanned_at, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt, color_transfer, color_primaries, video_fps
		FROM episode_files WHERE id = $1`, id).
		Scan(&f.ID, &f.EpisodeID, &f.Path, &f.SizeBytes, &f.Container,
			&f.VideoCodec, &f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs,
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt, &f.ColorTransfer, &f.ColorPrimaries, &f.VideoFPS)
	if err != nil {
		return nil, err
	}
	// 2026-05-19 audit (BE-H1) — log corrupt JSONB rows.
	unmarshalTracks(audioJSON, &f.AudioTracks, f.ID, "audio")
	unmarshalTracks(subtitleJSON, &f.SubtitleTracks, f.ID, "subtitle")
	return f, nil
}

// GetContentRatingForEpisodeFile returns the content_rating of the show that
// owns episodeFileID, for parental-ceiling enforcement on the read/playback
// path (issue #462) — content_rating lives on media_items, not per-episode.
// Empty string (nil error) means unrated; callers must treat that as
// EXCLUDED under any restriction, matching AllowedRatingsForMax/RatingAllowed.
// A missing episodeFileID returns pgx.ErrNoRows, same as the file lookups.
func (q *Queries) GetContentRatingForEpisodeFile(ctx context.Context, episodeFileID int64) (string, error) {
	var rating string
	err := q.pool.QueryRow(ctx, `
		SELECT COALESCE(mi.content_rating, '')
		FROM episode_files ef
		JOIN tv_episodes e ON e.id = ef.episode_id
		JOIN media_items mi ON mi.id = e.media_item_id
		WHERE ef.id = $1`, episodeFileID).Scan(&rating)
	if err != nil {
		return "", err
	}
	return rating, nil
}

// GetContentRatingForMediaFile is the movie-file counterpart of
// GetContentRatingForEpisodeFile (issue #462).
func (q *Queries) GetContentRatingForMediaFile(ctx context.Context, mediaFileID int64) (string, error) {
	var rating string
	err := q.pool.QueryRow(ctx, `
		SELECT COALESCE(mi.content_rating, '')
		FROM media_files mf
		JOIN media_items mi ON mi.id = mf.media_item_id
		WHERE mf.id = $1`, mediaFileID).Scan(&rating)
	if err != nil {
		return "", err
	}
	return rating, nil
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

// hdrColorTransfers are the ffprobe color_transfer values that mark a
// file as HDR: smpte2084 = PQ (HDR10 / Dolby Vision base layer),
// arib-std-b67 = HLG. Everything else (bt709, unset) is SDR. Mirrors the
// frontend's formatHdr() in lib/detail.ts so the browse badge and the
// detail quality chip agree on what counts as HDR.
var hdrColorTransfers = []string{"smpte2084", "arib-std-b67"}

// GetMediaItemsWithHDR returns a set of media_item_ids that have at least
// one HDR file (movie media_files OR show episode_files), detected via
// color_transfer rather than version_tag — HDR isn't reliably encoded in
// the release tag, but ffprobe always records the transfer function
// (migration 025_video_color_metadata). Mirrors GetMediaItemsWith4K.
// Used by the API layer to annotate list responses with has_hdr badges.
func (q *Queries) GetMediaItemsWithHDR(ctx context.Context, mediaItemIDs []int64) (map[int64]bool, error) {
	if len(mediaItemIDs) == 0 {
		return map[int64]bool{}, nil
	}
	rows, err := q.pool.Query(ctx,
		`SELECT DISTINCT media_item_id FROM media_files
		 WHERE media_item_id = ANY($1) AND color_transfer = ANY($2)
		 UNION
		 SELECT DISTINCT e.media_item_id FROM episode_files ef
		 JOIN tv_episodes e ON e.id = ef.episode_id
		 WHERE e.media_item_id = ANY($1) AND ef.color_transfer = ANY($2)`, mediaItemIDs, hdrColorTransfers)
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
		`INSERT INTO episode_files (episode_id, path, size_bytes, container, video_codec, audio_codec, resolution, bitrate, duration_ms, file_hash, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt, video_fps)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
		 ON CONFLICT (path) DO UPDATE SET
		   episode_id = EXCLUDED.episode_id,
		   size_bytes = EXCLUDED.size_bytes, container = EXCLUDED.container,
		   video_codec = EXCLUDED.video_codec, audio_codec = EXCLUDED.audio_codec,
		   resolution = EXCLUDED.resolution, bitrate = EXCLUDED.bitrate,
		   duration_ms = EXCLUDED.duration_ms, file_hash = EXCLUDED.file_hash,
		   audio_tracks = EXCLUDED.audio_tracks, subtitle_tracks = EXCLUDED.subtitle_tracks,
		   version_tag = EXCLUDED.version_tag,
		   video_profile = EXCLUDED.video_profile, video_pix_fmt = EXCLUDED.video_pix_fmt, video_fps = EXCLUDED.video_fps,
		   scanned_at = NOW()
		 RETURNING id, scanned_at`,
		f.EpisodeID, f.Path, f.SizeBytes, f.Container, f.VideoCodec,
		f.AudioCodec, f.Resolution, f.Bitrate, f.DurationMs, f.FileHash, aj, sj, f.VersionTag,
		f.VideoProfile, f.VideoPixFmt, f.VideoFPS,
	).Scan(&f.ID, &f.ScannedAt)
}

// GetEpisodeFileByPath returns an episode file by its filesystem path.
func (q *Queries) GetEpisodeFileByPath(ctx context.Context, path string) (*models.EpisodeFile, error) {
	f := &models.EpisodeFile{}
	var audioJSON, subtitleJSON []byte
	err := q.pool.QueryRow(ctx,
		`SELECT id, episode_id, path, size_bytes, COALESCE(container, ''), COALESCE(video_codec, ''), COALESCE(audio_codec, ''),
		        COALESCE(resolution, ''), COALESCE(bitrate, 0), COALESCE(duration_ms, 0),
		        file_hash, scanned_at, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt, color_transfer, color_primaries, video_fps
		 FROM episode_files WHERE path = $1`, path,
	).Scan(&f.ID, &f.EpisodeID, &f.Path, &f.SizeBytes, &f.Container, &f.VideoCodec,
		&f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs, &f.FileHash, &f.ScannedAt,
		&audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt, &f.ColorTransfer, &f.ColorPrimaries, &f.VideoFPS,
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
