package db

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

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
	// Why names what the rows ARE, in an admin's terms, so the preview does not
	// just list tables nobody has a reason to recognise.
	//
	// Every table in the cascade closure has one, and
	// TestRetypeCasualtyNounsCoverTheWholeClosure fails when a new table appears
	// without it — the closure is derived from the schema, so table DISCOVERY
	// cannot go stale, but the words an admin reads are hand-written and can.
	// Two tables were already missing (party_invites, watch_party_participants)
	// and the preview rendered them with a dangling em-dash. The field stays
	// omitempty and the UI degrades to the bare table name, because a missing
	// description should never be worse than a wrong one.
	Why string `json:"why,omitempty"`
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

// cascadeEdge is one ON DELETE CASCADE foreign key: deleting a row of Parent
// takes with it every row of Child whose ChildCol matches the parent's ParentCol.
type cascadeEdge struct {
	Child, ChildCol, Parent, ParentCol string
}

// cascadeEdgesFrom reads every single-column ON DELETE CASCADE foreign key in
// the public schema. relname, not regclass::text: the latter schema-qualifies or
// pre-quotes a name that is not on the search path, which quoteIdent would then
// double-quote into invalid SQL. The graph is walked in Go rather than in one recursive CTE
// because a table can be reachable by SEVERAL paths — skip_markers hangs off
// both media_files and episode_files, watch_progress off both media_items and
// tv_episodes — and those rows must be counted once, not once per path.
//
// Multi-column foreign keys are excluded. The schema has exactly ONE
// (recommendation_impressions -> recommendation_slates), and it is harmless here
// only because recommendation_slates hangs off user_profiles and is unreachable
// from media_items — not because none exists, which an earlier version of this
// comment claimed. A predicate built from one column of a composite key would
// silently under-report rather than fail, so
// TestRetypeCascadeClosureCoversTheWholeSchema fails if a composite key whose
// parent IS reachable ever appears.
func (q *Queries) cascadeEdgesFrom(ctx context.Context) ([]cascadeEdge, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT ch.relname::text, a.attname::text,
		       pt.relname::text, af.attname::text
		FROM pg_constraint c
		JOIN unnest(c.conkey)  WITH ORDINALITY k(attnum, ord)  ON true
		JOIN unnest(c.confkey) WITH ORDINALITY fk(attnum, ord) ON fk.ord = k.ord
		JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum = k.attnum
		JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = fk.attnum
		JOIN pg_class pt ON pt.oid = c.confrelid
		JOIN pg_class ch ON ch.oid = c.conrelid
		JOIN pg_namespace n ON n.oid = ch.relnamespace
		WHERE c.contype = 'f' AND c.confdeltype = 'c'
		  AND array_length(c.conkey, 1) = 1
		  AND n.nspname = 'public'`)
	if err != nil {
		return nil, fmt.Errorf("read cascade edges: %w", err)
	}
	defer rows.Close()
	var out []cascadeEdge
	for rows.Next() {
		var e cascadeEdge
		if err := rows.Scan(&e.Child, &e.ChildCol, &e.Parent, &e.ParentCol); err != nil {
			return nil, fmt.Errorf("scan cascade edge: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// doomedRowsPredicate renders the WHERE clause matching every row of `table`
// that a retype destroys, as the OR of its incoming cascade edges. Recursive,
// because a grandchild's parents are themselves defined by their own parents,
// and cycle-guarded by `path` (the schema has none today; a future one would
// otherwise hang here rather than fail).
//
// media_items is the base case and the only place the query parameters appear.
// Table and column names come from pg_constraint — never from user input — and
// are quoted anyway so a future reader does not have to re-derive that.
func doomedRowsPredicate(table string, edges []cascadeEdge, path map[string]bool) (string, bool) {
	if table == "media_items" {
		return "library_id = $1 AND type <> $2", true
	}
	if path[table] {
		return "", false
	}
	path[table] = true
	defer delete(path, table)

	var terms []string
	for _, e := range edges {
		if e.Child != table {
			continue
		}
		parentPred, ok := doomedRowsPredicate(e.Parent, edges, path)
		if !ok {
			continue
		}
		terms = append(terms, fmt.Sprintf("%s IN (SELECT %s FROM %s WHERE %s)",
			quoteIdent(e.ChildCol), quoteIdent(e.ParentCol), quoteIdent(e.Parent), parentPred))
	}
	if len(terms) == 0 {
		return "", false
	}
	return strings.Join(terms, " OR "), true
}

// quoteIdent renders a table or column name for interpolation. Every name here
// comes from pg_constraint, never from a request — but the file builds SQL with
// fmt.Sprintf, and "trust me, it came from the catalog" is not something a
// future reader should have to re-derive from three call sites up. Sanitize
// makes it self-evident and costs nothing.
func quoteIdent(s string) string { return pgx.Identifier{s}.Sanitize() }

// retypeCasualtyNoun names what a table's rows ARE, in the admin's terms.
//
// Deliberately NOT mergeChildren's `why`, which this used to borrow: those
// strings describe what a MERGE does, and ten of them begin "re-parented:" — so
// the one screen whose whole job is to say what is about to be destroyed was
// telling an admin their live watch party would be "re-parented". A review
// caught it. A table with no entry here shows its name alone, which is worse
// prose but never a false statement.
var retypeCasualtyNoun = map[string]string{
	"media_files":                 "playable movie files (the files on disk are untouched)",
	"tv_seasons":                  "season rows",
	"tv_episodes":                 "episode rows",
	"episode_files":               "playable episode files (the files on disk are untouched)",
	"watch_progress":              "how far people got, per person and per episode",
	"watchlist_items":             "watchlist entries",
	"user_ratings":                "star ratings people gave",
	"item_feedback":               "like/dislike signals that train the recommender",
	"taste_seeds":                 "onboarding taste picks",
	"collection_items":            "memberships in curated collections",
	"recently_surfaced_items":     "records of what has already been shown",
	"recap_conversations":         "people's recap Q&A threads",
	"recap_conversation_turns":    "the questions and answers in those threads",
	"recap_conversation_requests": "pending and completed recap questions",
	"episode_recaps":              "generated recaps (each cost an LLM call)",
	"artwork":                     "posters and backdrops",
	"media_cast":                  "cast and crew links",
	"media_genres":                "genre links",
	"external_ids":                "provider id links",
	"watch_parties":               "watch party rooms, including any that are LIVE right now",
	"recommendation_impressions":  "recommender telemetry",
	"recommendation_watch_events": "recommender outcome history",
	"skip_markers":                "detected intro/recap/credits markers",
	"skip_marker_analysis":        "intro/credits detection results",
	"party_invites":               "watch party invitations people sent or received",
	"watch_party_participants":    "who is in a watch party room",
}

// PreviewLibraryRetype counts what changing the library's type would destroy.
// Read-only.
//
// It enumerates DELETIONS only. Two foreign keys into this closure are ON DELETE
// SET NULL rather than CASCADE — watch_parties.episode_id and
// recap_conversation_turns.up_to_episode_id — so a row on a KEPT item that
// points at a DOOMED item's episode survives with that column nulled, and the
// preview says nothing about it. That is a live watch party left on no episode,
// which CLAUDE.md's merge section calls the nastier half. It needs a library
// holding both types at once to happen at all, which is why it is recorded
// rather than built; a review found it and it is in the runbook's known limits.
//
// The table list is derived from pg_constraint at query time — the TRANSITIVE
// cascade closure of media_items, not just its direct children. An earlier
// version drove it off mergeChildren plus one hand-coded exception for
// episode_files, and a review showed that silently omitted skip_markers,
// skip_marker_analysis and recap_conversation_turns: a person's whole recap Q&A
// thread was destroyed without appearing in the preview at all, while the
// comment here claimed nothing could be missing. mergeChildren is pinned against
// pg_constraint for DIRECT children only, so it could never have carried the
// second hop. Asking the schema removes the class rather than the instance.
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

	edges, err := q.cascadeEdgesFrom(ctx)
	if err != nil {
		return nil, fmt.Errorf("preview retype: %w", err)
	}
	tables := map[string]bool{}
	for _, e := range edges {
		tables[e.Child] = true
	}
	names := make([]string, 0, len(tables))
	for t := range tables {
		names = append(names, t)
	}
	sort.Strings(names)

	for _, t := range names {
		// media_items is a cascade child of libraries, so it is in its own
		// closure. It is already reported as ItemsToDelete; listing it again as
		// a casualty would double it in an admin's head.
		if t == "media_items" {
			continue
		}
		pred, ok := doomedRowsPredicate(t, edges, map[string]bool{})
		if !ok {
			continue // not reachable from media_items
		}
		var n int64
		if err := q.pool.QueryRow(ctx, fmt.Sprintf(
			`SELECT COUNT(*) FROM %s WHERE %s`, quoteIdent(t), pred),
			libraryID, wantMedia).Scan(&n); err != nil {
			return nil, fmt.Errorf("preview retype: count %s: %w", t, err)
		}
		if n > 0 {
			p.Casualties = append(p.Casualties, RetypeCasualty{
				Table: t, Rows: n, Why: retypeCasualtyNoun[t],
			})
		}
	}
	return p, nil
}

// ErrLibraryGone means the library disappeared between the caller's lookup and
// the transaction. Callers turn it into a 404 rather than a misleading success.
var ErrLibraryGone = errors.New("library no longer exists")

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
// It covers the ITEM count only, not the casualty counts the preview also
// showed. Between preview and confirm, playback, ratings and watchlist adds can
// change how many child rows go while the item count is unchanged, and this
// proceeds. Widening the interlock to every casualty would refuse the operation
// any time somebody watched something, which is most of the time; the honest
// answer is that the titles are what is pinned, and the runbook says so.
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
			// A distinguishable sentinel, not (0, nil). The library can be
			// deleted between the handler's lookup and this transaction, and
			// reporting that as "succeeded, deleted nothing" made the handler
			// answer 200 and launch a rescan of a library that no longer exists.
			return 0, ErrLibraryGone
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

	if q.testHookInRetypeTxn != nil {
		q.testHookInRetypeTxn()
	}

	tag, err := tx.Exec(ctx,
		`DELETE FROM media_items WHERE library_id = $1 AND type <> $2`, libraryID, wantMedia)
	if err != nil {
		return 0, fmt.Errorf("retype: purge items: %w", err)
	}
	// Belt and braces, and cheap. The recount above is only atomic with the
	// DELETE because the FOR UPDATE on the library row conflicts with the
	// FOR KEY SHARE that media_items' library_id foreign key takes on that same
	// row, so a concurrent insert into this library BLOCKS. That is a real
	// guarantee and a review confirmed it holds under load — but it rests on a
	// lock interaction nothing in the code names, and a future reader
	// "correcting" FOR UPDATE to the semantically tidier FOR NO KEY UPDATE would
	// silently turn the interlock into a best-effort check, because that lock
	// does NOT conflict with key-share. Comparing what was actually deleted
	// makes the guarantee hold whatever the lock does, and it is testable.
	if tag.RowsAffected() != expectedItems {
		return 0, &ErrRetypeCountMismatch{Expected: expectedItems, Actual: tag.RowsAffected()}
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
