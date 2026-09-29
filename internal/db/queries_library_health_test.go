package db

// The tally behind the mis-typed-library report (#510 follow-up).
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise.
//
// Why this needs a real database rather than a unit test: the whole question is
// which COLUMN counts as "matched", and getting that wrong produces a report
// that says everything is fine. match_status is the trap — it DEFAULTs to
// 'matched' and UpsertMediaItem never writes it, so the rows this report exists
// to find are all labelled 'matched' with no tmdb_id. Only the schema can
// demonstrate that.

import (
	"context"
	"testing"
)

// findHealth returns one library's tally, failing if the query dropped it. The
// report is a list an admin reads, so a library going missing is a defect in
// itself — an empty library must read as "no titles yet", not as absent.
func findHealth(t *testing.T, rows []LibraryMatchHealth, libID int64) LibraryMatchHealth {
	t.Helper()
	for _, r := range rows {
		if r.LibraryID == libID {
			return r
		}
	}
	t.Fatalf("library %d missing from the health report entirely (%d rows returned)", libID, len(rows))
	return LibraryMatchHealth{}
}

func TestGetLibraryMatchHealthCountsProviderIdsNotMatchStatus(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)

	mk := func(title string, tmdbID *int) {
		t.Helper()
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, tmdb_id)
			 VALUES ($1,'movie',$2,$2,$3)`, libID, title+" "+sfx, tmdbID); err != nil {
			t.Fatalf("insert %s: %v", title, err)
		}
	}
	id := func(n int) *int { return &n }

	mk("Matched A", id(101))
	mk("Matched B", id(102))
	mk("Unmatched A", nil)
	mk("Unmatched B", nil)
	mk("Unmatched C", nil)

	// Every one of those rows carries match_status='matched' without anyone
	// writing it — that is migration 007's DEFAULT, and UpsertMediaItem never
	// sets the column. This is the precondition that makes the choice of column
	// load-bearing rather than a preference: a report counting match_status
	// would call this library 5/5 healthy while three of its titles have no
	// metadata at all.
	var defaulted int
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM media_items WHERE library_id = $1 AND match_status = 'matched'`,
		libID).Scan(&defaulted); err != nil {
		t.Fatalf("count match_status: %v", err)
	}
	if defaulted != 5 {
		t.Fatalf("precondition: %d of 5 rows read as match_status='matched'; if that is no longer the DEFAULT this test's point has moved", defaulted)
	}

	rows, err := q.GetLibraryMatchHealth(ctx)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	h := findHealth(t, rows, libID)
	if h.Items != 5 {
		t.Errorf("items = %d, want 5", h.Items)
	}
	if h.Matched != 2 {
		t.Errorf("matched = %d, want 2 — the tally must count tmdb_id, not match_status, or a library of titles that matched nothing reads as fully healthy", h.Matched)
	}
}

func TestGetLibraryMatchHealthKeepsEmptyLibrariesAndScopesPerLibrary(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	empty := seedTestLibrary(t, q, ownerID)
	populated := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)

	for i := 0; i < 3; i++ {
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, tmdb_id)
			 VALUES ($1,'movie',$2,$2,$3)`,
			populated, "Scoped "+sfx+" "+string(rune('a'+i)), 500+i); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}

	rows, err := q.GetLibraryMatchHealth(ctx)
	if err != nil {
		t.Fatalf("query: %v", err)
	}

	// The LEFT JOIN is the point: an inner join drops the empty library, and a
	// report that silently omits a library reads as "it was deleted".
	e := findHealth(t, rows, empty)
	if e.Items != 0 || e.Matched != 0 {
		t.Errorf("empty library reports items=%d matched=%d, want 0/0", e.Items, e.Matched)
	}

	// And the counts must not bleed between libraries — the grouping is what
	// makes this per-library rather than an install-wide average.
	p := findHealth(t, rows, populated)
	if p.Items != 3 || p.Matched != 3 {
		t.Errorf("populated library reports items=%d matched=%d, want 3/3", p.Items, p.Matched)
	}
	if p.Type == "" || p.Name == "" {
		t.Error("type and name must ride along; the warning names the type and an admin needs the name to act on it")
	}
}
