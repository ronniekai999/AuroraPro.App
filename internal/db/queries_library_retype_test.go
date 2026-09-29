package db

// Changing a library's type purges catalog rows. CLAUDE.md calls the
// catalog-delete path the most dangerous code in this repo and records that four
// of the five defects in the withdrawn library-repointing work were found by
// RUNNING code against Postgres rather than by reading it. These run it.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// retypeFixture builds a library in the #510 shape: marked 'movie', holding
// media_items of type 'movie' that are really TV series, with the user data an
// admin would be destroying attached to them.
type retypeFixture struct {
	libID     int64
	ownerID   int64
	profileID int64
	movieIDs  []int64
	showID    int64 // a correctly-typed row, to prove the purge is scoped
}

func seedRetypeFixture(t *testing.T, q *Queries, movies int) retypeFixture {
	t.Helper()
	ctx := context.Background()
	f := retypeFixture{ownerID: seedTestUser(t, q)}
	f.libID = seedTestLibrary(t, q, f.ownerID)
	sfx := randomSuffix(t)

	if err := q.pool.QueryRow(ctx,
		`INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
		 VALUES ($1,'retype-probe',TRUE,'en','off') RETURNING id`, f.ownerID).Scan(&f.profileID); err != nil {
		t.Fatalf("insert profile: %v", err)
	}

	mk := func(typ models.MediaType, title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
			 VALUES ($1,$2,$3,$3,'',0,0,'',0) RETURNING id`, f.libID, typ, title).Scan(&id); err != nil {
			t.Fatalf("insert item: %v", err)
		}
		return id
	}
	for i := 0; i < movies; i++ {
		f.movieIDs = append(f.movieIDs, mk(models.MediaMovie, "Mistyped "+sfx+" "+string(rune('a'+i))))
	}
	f.showID = mk(models.MediaShow, "Correctly Typed "+sfx)

	// User data on the first mis-typed item — the things an admin is actually
	// being asked to approve the loss of.
	var watchlistID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO watchlists (profile_id, name) VALUES ($1,'List '||$2) RETURNING id`,
		f.profileID, sfx).Scan(&watchlistID); err != nil {
		t.Fatalf("insert watchlist: %v", err)
	}
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO watchlist_items (watchlist_id, media_item_id) VALUES ($1,$2)`,
		watchlistID, f.movieIDs[0]); err != nil {
		t.Fatalf("insert watchlist_items: %v", err)
	}
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms)
		 VALUES ($1,$2,$3,120000,7200000)`, f.ownerID, f.profileID, f.movieIDs[0]); err != nil {
		t.Fatalf("insert watch_progress: %v", err)
	}
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO user_ratings (profile_id, media_item_id, stars) VALUES ($1,$2,5)`,
		f.profileID, f.movieIDs[0]); err != nil {
		t.Fatalf("insert user_ratings: %v", err)
	}
	// And the same kinds of row on the correctly-typed item, which must survive.
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO watchlist_items (watchlist_id, media_item_id) VALUES ($1,$2)`,
		watchlistID, f.showID); err != nil {
		t.Fatalf("insert surviving watchlist_items: %v", err)
	}
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms)
		 VALUES ($1,$2,$3,60000,3600000)`, f.ownerID, f.profileID, f.showID); err != nil {
		t.Fatalf("insert surviving watch_progress: %v", err)
	}
	return f
}

func countWhere(t *testing.T, q *Queries, sql string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := q.pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func TestPreviewLibraryRetypeCountsWhatWouldBeDestroyed(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	f := seedRetypeFixture(t, q, 3)

	p, err := q.PreviewLibraryRetype(ctx, f.libID, models.LibraryShows)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if p == nil {
		t.Fatal("preview returned nil for an existing library")
	}
	if p.ItemsToDelete != 3 {
		t.Errorf("items_to_delete = %d, want 3 (the movie-typed rows)", p.ItemsToDelete)
	}
	if p.ItemsKept != 1 {
		t.Errorf("items_kept = %d, want 1 (the already-correct row)", p.ItemsKept)
	}
	if p.CurrentType != models.LibraryMovies || p.TargetType != models.LibraryShows {
		t.Errorf("preview reports %s -> %s", p.CurrentType, p.TargetType)
	}

	// The casualties are the point of the preview: an admin must see the user
	// data, named, before approving. A preview that reports only an item count
	// would have them approve "3 titles" without mentioning the ratings.
	got := map[string]int64{}
	for _, c := range p.Casualties {
		got[c.Table] = c.Rows
		// The description must describe DESTRUCTION. It used to be borrowed
		// verbatim from mergeChildren, where ten of the nineteen entries begin
		// "re-parented:" because that is what a MERGE does — so the one screen
		// whose job is to say what is about to be destroyed told an admin their
		// live watch party would be re-parented. A review caught it.
		if c.Why == "" {
			t.Errorf("casualty %s carries no description; a table name alone tells an admin nothing", c.Table)
		}
		if strings.Contains(c.Why, "re-parented") || strings.Contains(c.Why, "merge") {
			t.Errorf("casualty %s is described in the MERGE's terms (%q); these rows are being deleted, not moved", c.Table, c.Why)
		}
		if c.Rows == 0 {
			t.Errorf("casualty %s listed with 0 rows; zero-row tables must be omitted or they bury the lines that matter", c.Table)
		}
	}
	for _, want := range []string{"watchlist_items", "watch_progress", "user_ratings"} {
		if got[want] != 1 {
			t.Errorf("casualties[%s] = %d, want 1 — this is user data the retype destroys and the preview must say so", want, got[want])
		}
	}
}

// The transitive closure is the point. An earlier version counted only DIRECT
// children of media_items plus one hand-coded exception, and a review showed
// that silently omitted skip_markers, skip_marker_analysis and
// recap_conversation_turns — a person's whole recap Q&A thread destroyed without
// appearing in the preview, while the comment claimed nothing could be missing.
func TestPreviewLibraryRetypeCountsGrandchildrenNotJustDirectChildren(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	f := seedRetypeFixture(t, q, 1)
	doomed := f.movieIDs[0]

	// media_files -> skip_markers / skip_marker_analysis: two hops.
	var fileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO media_files (media_item_id, path, file_hash, size_bytes)
		 VALUES ($1,$2,'h',1) RETURNING id`, doomed, "/tmp/retype-"+randomSuffix(t)+".mkv").Scan(&fileID); err != nil {
		t.Fatalf("insert media_files: %v", err)
	}
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO skip_markers (media_file_id, kind, start_ms, end_ms, detector)
		 VALUES ($1,'intro',0,30000,'manual')`, fileID); err != nil {
		t.Fatalf("insert skip_markers: %v", err)
	}

	// recap_conversations -> recap_conversation_turns: the one CLAUDE.md singles
	// out as a person's private thread.
	var convID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO recap_conversations (profile_id, media_item_id, generation_epoch)
		 VALUES ($1,$2,1) RETURNING id`, f.profileID, doomed).Scan(&convID); err != nil {
		t.Fatalf("insert recap_conversations: %v", err)
	}
	var reqID string
	if err := q.pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&reqID); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO recap_conversation_turns
		   (conversation_id, request_id, question, answer,
		    boundary_season, boundary_episode, boundary_title, grounding_mode)
		 VALUES ($1,$2::uuid,'q','a',1,1,'t','grounded')`, convID, reqID); err != nil {
		t.Fatalf("insert recap_conversation_turns: %v", err)
	}

	p, err := q.PreviewLibraryRetype(ctx, f.libID, models.LibraryShows)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	named := map[string]int64{}
	for _, c := range p.Casualties {
		named[c.Table] = c.Rows
	}
	for _, want := range []string{"skip_markers", "recap_conversation_turns"} {
		if named[want] != 1 {
			t.Errorf("casualties[%s] = %d, want 1 — it cascades transitively and an admin is approving its destruction without being told", want, named[want])
		}
	}

	// And the counts are real: confirm and the rows are gone.
	if _, err := q.RetypeLibrary(ctx, f.libID, models.LibraryShows, p.ItemsToDelete); err != nil {
		t.Fatalf("retype: %v", err)
	}
	for _, tbl := range []string{"skip_markers", "recap_conversation_turns"} {
		if n := countWhere(t, q, `SELECT COUNT(*) FROM `+tbl); n != 0 {
			t.Errorf("%d rows remain in %s after the retype; the preview counted rows that do not actually go", n, tbl)
		}
	}
}

// A table reachable by TWO cascade paths must be counted ONCE. skip_markers
// hangs off both media_files and episode_files; watch_progress off both
// media_items and tv_episodes. Summing per path would overstate what an admin is
// about to lose, which is a different way of telling them the wrong number.
func TestPreviewLibraryRetypeCountsMultiPathTablesOnce(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	f := seedRetypeFixture(t, q, 1)
	doomed := f.movieIDs[0]

	var seasonID, epID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1,1) RETURNING id`,
		doomed).Scan(&seasonID); err != nil {
		t.Fatalf("insert season: %v", err)
	}
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_episodes (season_id, media_item_id, episode_number) VALUES ($1,$2,1) RETURNING id`,
		seasonID, doomed).Scan(&epID); err != nil {
		t.Fatalf("insert episode: %v", err)
	}
	// watch_progress reachable via media_item_id AND episode_id, in one row.
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, episode_id, position_ms, duration_ms)
		 VALUES ($1,$2,$3,$4,1000,2000)`, f.ownerID, f.profileID, doomed, epID); err != nil {
		t.Fatalf("insert episode watch_progress: %v", err)
	}

	p, err := q.PreviewLibraryRetype(ctx, f.libID, models.LibraryShows)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	var wp int64
	for _, c := range p.Casualties {
		if c.Table == "watch_progress" {
			wp = c.Rows
		}
	}
	// The fixture puts one item-level row on this item; the episode row above is
	// the second. Both are real, and neither is double-counted.
	actual := countWhere(t, q, `SELECT COUNT(*) FROM watch_progress WHERE media_item_id = $1`, doomed)
	if wp != actual {
		t.Errorf("preview reports %d watch_progress rows, the table holds %d — a table reachable by two cascade paths must be counted once", wp, actual)
	}
}

func TestPreviewLibraryRetypeIsDerivedFromTheCascadeChildList(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	f := seedRetypeFixture(t, q, 2)

	// Put one row on a doomed item in EVERY generic child that takes a plain
	// (profile_id, media_item_id) shape, and assert the preview names each. The
	// list comes from mergeChildren, which a drift guard already pins against
	// pg_constraint — so a future cascade child cannot be silently absent from
	// the preview, which is what a hand-written list here would allow.
	for _, tbl := range []struct{ table, insert string }{
		{"item_feedback", `INSERT INTO item_feedback (profile_id, media_item_id, feedback) VALUES ($1,$2,'up')`},
		{"taste_seeds", `INSERT INTO taste_seeds (profile_id, media_item_id, source) VALUES ($1,$2,'onboarding')`},
	} {
		if _, err := q.pool.Exec(ctx, tbl.insert, f.profileID, f.movieIDs[0]); err != nil {
			t.Fatalf("insert %s: %v", tbl.table, err)
		}
	}

	p, err := q.PreviewLibraryRetype(ctx, f.libID, models.LibraryShows)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	named := map[string]bool{}
	for _, c := range p.Casualties {
		named[c.Table] = true
	}
	for _, want := range []string{"item_feedback", "taste_seeds"} {
		if !named[want] {
			t.Errorf("%s holds a row on a doomed item but the preview does not name it", want)
		}
	}

	// Nothing is deleted by a preview. Obvious, and worth an assertion, because
	// a preview that mutates is the single worst outcome here.
	if n := countWhere(t, q, `SELECT COUNT(*) FROM media_items WHERE library_id = $1`, f.libID); n != 3 {
		t.Errorf("%d items remain after a PREVIEW, want 3 — the preview must be read-only", n)
	}
}

func TestRetypeLibraryPurgesRewritesTypeAndSparesCorrectRows(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	f := seedRetypeFixture(t, q, 3)

	deleted, err := q.RetypeLibrary(ctx, f.libID, models.LibraryShows, 3)
	if err != nil {
		t.Fatalf("retype: %v", err)
	}
	if deleted != 3 {
		t.Errorf("deleted = %d, want 3", deleted)
	}

	if n := countWhere(t, q,
		`SELECT COUNT(*) FROM media_items WHERE library_id = $1 AND type = 'movie'`, f.libID); n != 0 {
		t.Errorf("%d movie-typed rows survived the purge; they would keep their files in the wrong table, unreachable by any later prune", n)
	}
	// The correctly-typed row and its user data are untouched. A retype that
	// clears the whole library would be far easier to write and would destroy
	// history it had no reason to.
	if n := countWhere(t, q,
		`SELECT COUNT(*) FROM media_items WHERE id = $1`, f.showID); n != 1 {
		t.Error("the already-correctly-typed item was deleted")
	}
	if n := countWhere(t, q,
		`SELECT COUNT(*) FROM watch_progress WHERE media_item_id = $1`, f.showID); n != 1 {
		t.Error("watch progress on the correctly-typed item was destroyed")
	}

	var typ models.LibraryType
	if err := q.pool.QueryRow(ctx, `SELECT type FROM libraries WHERE id = $1`, f.libID).Scan(&typ); err != nil {
		t.Fatalf("read type: %v", err)
	}
	if typ != models.LibraryShows {
		t.Errorf("library type = %q, want %q", typ, models.LibraryShows)
	}

	// The cascade really did fire: leftover children pointing at deleted items
	// would be the phantom-row state this whole operation exists to avoid.
	if n := countWhere(t, q,
		`SELECT COUNT(*) FROM watch_progress WHERE media_item_id = $1`, f.movieIDs[0]); n != 0 {
		t.Errorf("%d watch_progress rows still reference a deleted item", n)
	}
}

func TestRetypeLibraryRefusesWhenTheCatalogMovedSincePreview(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	f := seedRetypeFixture(t, q, 3)

	// The admin was shown 3. A scan finished, or a second admin acted, and there
	// are now 4. Deleting 4 on the strength of an approval for 3 is exactly the
	// failure the interlock exists for.
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
		 VALUES ($1,'movie','Arrived Late','Arrived Late','',0,0,'',0)`, f.libID); err != nil {
		t.Fatalf("insert late arrival: %v", err)
	}

	_, err := q.RetypeLibrary(ctx, f.libID, models.LibraryShows, 3)
	var mismatch *ErrRetypeCountMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("retype with a stale count returned %v, want a count mismatch", err)
	}
	if mismatch.Expected != 3 || mismatch.Actual != 4 {
		t.Errorf("mismatch reports expected=%d actual=%d, want 3/4 — an admin needs both numbers to decide", mismatch.Expected, mismatch.Actual)
	}

	// And nothing happened. A refusal that half-applied would be worse than one
	// that deleted too much, because it leaves a state nobody previewed.
	if n := countWhere(t, q, `SELECT COUNT(*) FROM media_items WHERE library_id = $1`, f.libID); n != 5 {
		t.Errorf("%d items remain after a REFUSED retype, want 5 (4 movies + 1 show)", n)
	}
	var typ models.LibraryType
	if err := q.pool.QueryRow(ctx, `SELECT type FROM libraries WHERE id = $1`, f.libID).Scan(&typ); err != nil {
		t.Fatalf("read type: %v", err)
	}
	if typ != models.LibraryMovies {
		t.Errorf("library type changed to %q despite the refusal", typ)
	}
}

func TestRetypeLibraryToTheSameTypeIsTheRepairPath(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	f := seedRetypeFixture(t, q, 2)

	// Production was remediated with hand-written SQL: UPDATE libraries SET
	// type='show' followed by a DELETE. A library left half-way through that —
	// marked 'show' but still full of 'movie' rows — is a real state, and the
	// operation must be able to finish the job rather than report "already the
	// right type, nothing to do".
	if _, err := q.pool.Exec(ctx, `UPDATE libraries SET type = 'show' WHERE id = $1`, f.libID); err != nil {
		t.Fatalf("hand-edit type: %v", err)
	}

	p, err := q.PreviewLibraryRetype(ctx, f.libID, models.LibraryShows)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if p.ItemsToDelete != 2 {
		t.Errorf("preview of a same-type repair reports %d items to delete, want 2 — the rows still disagree with the library", p.ItemsToDelete)
	}

	deleted, err := q.RetypeLibrary(ctx, f.libID, models.LibraryShows, 2)
	if err != nil {
		t.Fatalf("retype: %v", err)
	}
	if deleted != 2 {
		t.Errorf("same-type retype deleted %d, want 2", deleted)
	}
}

func TestRetypeLibraryRejectsUnknownTypesAndMissingLibraries(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	f := seedRetypeFixture(t, q, 1)

	// An unknown type must be rejected in Go, BEFORE anything is deleted.
	// `type <> 'wat'` matches EVERY row, so a retype that reached the DELETE
	// would purge the whole library including the correctly-typed rows.
	//
	// Two things about how this is asserted, both learned by mutating it.
	//
	// The expected count is deliberately 2 — what a garbage type would really
	// delete — because passing 1 let the COUNT INTERLOCK reject it instead, and
	// the test then passed with the type validation deleted outright.
	//
	// And checking only `err != nil` is still not enough: libraries.type carries
	// a CHECK constraint (movie|show), so with the validation removed the DELETE
	// runs, the UPDATE violates the constraint, and the transaction rolls back —
	// an error and an intact library, for a completely different reason. That
	// backstop is real and worth having, but it is the database's, not this
	// function's, and it only fires AFTER the rows have been deleted inside the
	// transaction. So assert the error is the validation's own.
	_, err := q.RetypeLibrary(ctx, f.libID, models.LibraryType("wat"), 2)
	if err == nil {
		t.Error("an unknown target type was accepted; this would purge the whole library including correctly-typed rows")
	} else if !strings.Contains(err.Error(), "unknown library type") {
		t.Errorf("unknown type was rejected by something other than the type check (%v); the rows had already been deleted inside the transaction by then", err)
	}
	if n := countWhere(t, q, `SELECT COUNT(*) FROM media_items WHERE library_id = $1`, f.libID); n != 2 {
		t.Errorf("%d items remain after a rejected type, want 2", n)
	}
	if _, err := q.PreviewLibraryRetype(ctx, f.libID, models.LibraryType("wat")); err == nil {
		t.Error("the preview accepted an unknown target type")
	}

	// A missing library is nil/0, not an error — the handler turns that into a
	// 404 rather than a 500.
	p, err := q.PreviewLibraryRetype(ctx, 0, models.LibraryShows)
	if err != nil || p != nil {
		t.Errorf("preview of a missing library returned (%v, %v), want (nil, nil)", p, err)
	}
	// A vanished library is a DISTINGUISHABLE error, not a quiet success. The
	// library can be deleted between the handler's lookup and this transaction,
	// and reporting that as "deleted nothing" made the handler answer 200 and
	// launch a rescan of a library that no longer exists.
	deleted, err := q.RetypeLibrary(ctx, 0, models.LibraryShows, 0)
	if !errors.Is(err, ErrLibraryGone) {
		t.Errorf("retype of a missing library returned (%d, %v), want ErrLibraryGone", deleted, err)
	}
	if deleted != 0 {
		t.Errorf("retype of a missing library reported %d deletions", deleted)
	}
}

// TestRetypeCascadeClosureCoversTheWholeSchema is the drift guard for the
// preview's table list.
//
// The list is derived from pg_constraint at query time, which is what makes the
// "cannot go stale" claim true — but the derivation has one documented blind
// spot: it takes single-column foreign keys only. There are none of any other
// shape today. If one is ever added, a predicate built from one column of a
// composite key would silently OVER-count rather than fail, so this fails
// instead and says what to do about it.
func TestRetypeCascadeClosureCoversTheWholeSchema(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	edges, err := q.cascadeEdgesFrom(ctx)
	if err != nil {
		t.Fatalf("edges: %v", err)
	}
	if len(edges) == 0 {
		t.Fatal("no cascade edges found at all — the query is wrong, not the schema")
	}

	// Reachability from media_items over the single-column cascade edges the
	// preview actually walks.
	depth := map[string]int{"media_items": 0}
	for changed := true; changed; {
		changed = false
		for _, e := range edges {
			if d, ok := depth[e.Parent]; ok {
				if cur, seen := depth[e.Child]; !seen || d+1 < cur {
					depth[e.Child] = d + 1
					changed = true
				}
			}
		}
	}

	// The one documented blind spot: cascadeEdgesFrom takes single-column
	// foreign keys only. A composite one is harmless as long as its PARENT is
	// out of reach of media_items — the schema has exactly one today
	// (recommendation_impressions -> recommendation_slates, which hangs off
	// user_profiles). One whose parent IS reachable would make its child's rows
	// doomed by a path the preview does not walk, so the admin would be told a
	// number smaller than the truth.
	rows, err := q.pool.Query(ctx, `
		SELECT c.conrelid::regclass::text, c.confrelid::regclass::text, c.conname
		FROM pg_constraint c
		WHERE c.contype = 'f' AND c.confdeltype = 'c'
		  AND array_length(c.conkey, 1) > 1`)
	if err != nil {
		t.Fatalf("query composite cascade keys: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var child, parent, name string
		if err := rows.Scan(&child, &parent, &name); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if _, reachable := depth[parent]; reachable {
			t.Errorf("%s cascades from %s by a MULTI-COLUMN foreign key (%s), and %s is reachable from media_items. cascadeEdgesFrom skips composite keys, so the retype preview under-reports those rows. Teach doomedRowsPredicate to build a multi-column predicate before relying on it.",
				child, parent, name, parent)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate: %v", err)
	}

	// And the closure really does reach past the first hop — stopping at direct
	// children is the defect this replaced, so a schema where that no longer
	// matters means this guard has stopped proving anything.
	deepest := 0
	for _, d := range depth {
		if d > deepest {
			deepest = d
		}
	}
	if deepest < 2 {
		t.Errorf("the deepest cascade path from media_items is %d hop(s); the preview used to stop at 1, so this guard needs a schema deeper than that to mean anything", deepest)
	}
	// The three the review found missing, by name.
	for _, want := range []string{"skip_markers", "skip_marker_analysis", "recap_conversation_turns"} {
		d, ok := depth[want]
		if !ok {
			t.Errorf("%s is no longer reachable from media_items by cascade; if that is deliberate, this guard needs updating", want)
			continue
		}
		if d < 2 {
			t.Errorf("%s is now a DIRECT child (depth %d); it was the grandchild case this guard was built for", want, d)
		}
	}
}
