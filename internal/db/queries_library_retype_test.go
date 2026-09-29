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
		if c.Why == "" {
			t.Errorf("casualty %s carries no description; a table name alone tells an admin nothing", c.Table)
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
	deleted, err := q.RetypeLibrary(ctx, 0, models.LibraryShows, 0)
	if err != nil || deleted != 0 {
		t.Errorf("retype of a missing library returned (%d, %v), want (0, nil)", deleted, err)
	}
}
