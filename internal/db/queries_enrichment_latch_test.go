package db

// Integration coverage for the #510 enrichment-recovery path: a TV show whose
// media_items row exists but whose (deferred) enrichment never ran must be able to
// recover, by BOTH of the two routes that exist.
//
// The NULL-column defect class this work uncovered is swept separately, in
// queries_enrichment_recovery_test.go — that sweep landed on main and goes much
// wider (six tables). Tests here are about the latch and the refresh rotation, not
// about NULL handling; the one NULL case kept is FindMediaItemByTitle's, because
// this branch narrows that projection rather than COALESCEing it.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise. Shares
// requireIntegrationDB / seedTestUser / seedTestLibrary / randomSuffix with
// queries_jsonb_integration_test.go.

import (
	"context"
	"testing"
	"time"
)

// insertShow creates a show row with explicit control over the three columns
// that decide enrichment state. A nil year inserts SQL NULL.
//
// overview/rating/runtime_minutes/content_rating are written as the zero values
// UpsertMediaItem really inserts, rather than left to default to NULL. That is
// deliberate: several queries read the WHOLE of media_items with no library
// filter, so a NULL left lying around by a fixture is visible to every other
// package running against this shared database. The tests that specifically need
// NULLs write them explicitly and say so.
func insertLatchShow(t *testing.T, q *Queries, libID int64, title string, year *int, lastMetadata, lastAttempt *time.Time) int64 {
	t.Helper()
	var id int64
	if err := q.pool.QueryRow(context.Background(),
		`INSERT INTO media_items
		   (library_id, type, title, sort_title, year, overview, rating, runtime_minutes,
		    content_rating, last_metadata, last_metadata_attempt)
		 VALUES ($1, 'show', $2, $2, $3, '', 0, 0, '', $4, $5) RETURNING id`,
		libID, title, year, lastMetadata, lastAttempt).Scan(&id); err != nil {
		t.Fatalf("insert show %q: %v", title, err)
	}
	return id
}

// The scanner's latch reads FindMediaItemByTitle().Attempted to tell "this show
// has already been dealt with" from "this show's row exists but its enrichment
// never ran". Those are the same thing as far as the row's existence goes, and
// opposite as far as re-queueing a full enrichment is concerned.
//
// All three states are asserted, because both boundaries matter: reporting an
// untouched row as attempted makes #510 permanent, and reporting an
// answered-but-unmatched row as un-attempted re-pays a full search on every
// scan that brings one of its files.
func TestFindMediaItemByTitleReportsWhetherRowWasAttempted(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	libID := seedTestLibrary(t, q, seedTestUser(t, q))
	year := 2016
	ts := time.Now().Add(-24 * time.Hour)

	cases := []struct {
		name         string
		lastMetadata *time.Time
		lastAttempt  *time.Time
		want         bool
		why          string
	}{
		{
			name: "never touched", want: false,
			why: "a row whose enrichment never ran must be re-queued for a full pass, or #510 is permanent",
		},
		{
			name: "stored", lastMetadata: &ts, lastAttempt: &ts, want: true,
			why: "an enriched row must not be re-enriched on every rescan",
		},
		{
			name: "attempted, nothing stored", lastAttempt: &ts, want: true,
			why: "a row a provider answered about with no match must not re-pay a search, embed and LLM re-match on every scan that brings a file",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			title := "Attempt " + tc.name + " " + randomSuffix(t)
			insertLatchShow(t, q, libID, title, &year, tc.lastMetadata, tc.lastAttempt)
			found, err := q.FindMediaItemByTitle(ctx, libID, "show", title)
			if err != nil {
				t.Fatalf("find: %v", err)
			}
			if found == nil {
				t.Fatal("show not found")
			}
			if found.Attempted != tc.want {
				t.Errorf("Attempted = %v, want %v — %s", found.Attempted, tc.want, tc.why)
			}
		})
	}
}

// A show whose folder carries no year parses to a NULL year. The wide
// projection scanned that into models.MediaItem.Year (a plain int) and failed
// with "cannot scan NULL into *int", so the canonical-row lookup errored on
// exactly the rows it exists to find — the scanner then fell through to
// UpsertMediaItem and lost the enrichment state entirely.
func TestFindMediaItemByTitleHandlesNullYear(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	libID := seedTestLibrary(t, q, seedTestUser(t, q))

	title := "No Year Show " + randomSuffix(t)
	id := insertLatchShow(t, q, libID, title, nil, nil, nil)

	found, err := q.FindMediaItemByTitle(ctx, libID, "show", title)
	if err != nil {
		t.Fatalf("NULL-year row must not fail the lookup, got: %v", err)
	}
	if found == nil {
		t.Fatal("NULL-year show not found")
	}
	if found.ID != id {
		t.Errorf("found id %d, want %d", found.ID, id)
	}
	if found.Attempted {
		t.Error("NULL-year untouched row reported as Attempted")
	}
}

// TouchMetadataAttempt records "a provider was asked and answered" without
// claiming metadata was stored. Conflating the two would corrupt
// RefreshStaleMetadata's smart diffing, which hands last_metadata to TMDB's
// changes API and is only meaningful for an item that really was matched.
func TestTouchMetadataAttemptDoesNotClaimMetadataWasStored(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	libID := seedTestLibrary(t, q, seedTestUser(t, q))
	id := insertLatchShow(t, q, libID, "Attempt Only "+randomSuffix(t), nil, nil, nil)

	if err := q.TouchMetadataAttempt(ctx, id); err != nil {
		t.Fatalf("touch attempt: %v", err)
	}

	var lastMetadata, lastAttempt *time.Time
	if err := q.pool.QueryRow(ctx,
		`SELECT last_metadata, last_metadata_attempt FROM media_items WHERE id = $1`,
		id).Scan(&lastMetadata, &lastAttempt); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if lastAttempt == nil {
		t.Error("last_metadata_attempt not stamped")
	}
	if lastMetadata != nil {
		t.Error("last_metadata was written by an attempt stamp — smart diffing would hand TMDB a changes-since date for an item that was never matched")
	}
}

// The starvation fix. Selection and ordering both read metadataProgressExpr, so
// the predicates here are built from that same constant: it keeps the test from
// drifting from production SQL, and scoping it to one row makes the assertion
// independent of the LIMIT 100 window (which other packages' fixtures share).
func TestUnmatchableItemsStopStarvingTheRefreshQueue(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	libID := seedTestLibrary(t, q, seedTestUser(t, q))

	// Exactly the production predicate, scoped to a single row.
	selected := func(id int64, maxAge time.Duration) bool {
		t.Helper()
		cutoff := time.Now().Add(-maxAge)
		var n int
		if err := q.pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM media_items WHERE id = $1
			   AND (`+metadataProgressExpr+` IS NULL OR `+metadataProgressExpr+` < $2)`,
			id, cutoff).Scan(&n); err != nil {
			t.Fatalf("selection probe: %v", err)
		}
		return n == 1
	}
	// Ordering key, same expression. nil ⇒ sorts first under NULLS FIRST.
	progress := func(id int64) *time.Time {
		t.Helper()
		var ts *time.Time
		if err := q.pool.QueryRow(ctx,
			`SELECT `+metadataProgressExpr+` FROM media_items WHERE id = $1`, id).Scan(&ts); err != nil {
			t.Fatalf("progress probe: %v", err)
		}
		return ts
	}

	const refresh = 168 * time.Hour
	unmatchable := insertLatchShow(t, q, libID, "Unmatchable "+randomSuffix(t), nil, nil, nil)

	// Before any attempt is recorded it is "never made progress": selected, and
	// sorted ahead of every item that has a timestamp.
	if !selected(unmatchable, refresh) {
		t.Fatal("a never-attempted item must be selected for refresh")
	}
	if progress(unmatchable) != nil {
		t.Fatal("a never-attempted item must sort first (NULL ordering key)")
	}

	// The provider answered, with no match: last_metadata stays NULL because
	// UpdateMediaMetadata was never reached.
	if err := q.TouchMetadataAttempt(ctx, unmatchable); err != nil {
		t.Fatalf("touch attempt: %v", err)
	}
	if progress(unmatchable) == nil {
		t.Error("an attempted item still sorts first — it would hold the head of the NULLS FIRST queue for ever and starve the rest of the catalog")
	}
	if selected(unmatchable, refresh) {
		t.Error("an item attempted moments ago is still selected for refresh — the pass would re-read the same unmatchable items on every tick")
	}
	// It must come back once the refresh interval has actually elapsed: this is
	// a rotation, not a permanent exclusion.
	if !selected(unmatchable, 0) {
		t.Error("an attempted item is excluded even past its refresh interval — it would never be retried")
	}

	// A genuinely enriched item stays on its normal rotation: due once
	// last_metadata is older than the interval, not before.
	old := time.Now().Add(-200 * time.Hour)
	recent := time.Now().Add(-1 * time.Hour)
	staleEnriched := insertLatchShow(t, q, libID, "Stale Enriched "+randomSuffix(t), nil, &old, &old)
	freshEnriched := insertLatchShow(t, q, libID, "Fresh Enriched "+randomSuffix(t), nil, &recent, &recent)
	if !selected(staleEnriched, refresh) {
		t.Error("an item last enriched 200h ago must be due at a 168h interval")
	}
	if selected(freshEnriched, refresh) {
		t.Error("an item enriched an hour ago must not be due at a 168h interval")
	}

	// A re-attempt that finds nothing must not leave an item permanently due on
	// the strength of its stale last_metadata — GREATEST takes the later event.
	if err := q.TouchMetadataAttempt(ctx, staleEnriched); err != nil {
		t.Fatalf("touch attempt on stale item: %v", err)
	}
	if selected(staleEnriched, refresh) {
		t.Error("a freshly re-attempted item is still due because its last_metadata is old — it would be re-read on every tick")
	}
}

// The starvation fix, pinned END-TO-END through GetStaleMetadataItems itself.
//
// TestUnmatchableItemsStopStarvingTheRefreshQueue below exercises the
// metadataProgressExpr predicate in isolation, which is NOT enough: because it
// builds its predicate from the same constant the query interpolates, changing
// the query body to plain `last_metadata` leaves it green. Only calling the real
// function catches that.
//
// Deliberately does NOT seed more than the query's LIMIT 100 window. An earlier
// version seeded 150 rows to demonstrate a two-pass rotation, which made this
// file pair a test that assumes the window is not overflowed with a test that
// overflows it by design — and an interrupted run left the excess rows behind and
// broke both tests permanently on the shared database. The decisive assertion
// here ("a stamped row is NOT selected") is a WHERE-clause property and so is
// window-independent anyway; it is what kills the mutation.
func TestGetStaleMetadataItemsRotatesPastAttemptedItems(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	libID := seedTestLibrary(t, q, seedTestUser(t, q))
	const refresh = 168 * time.Hour

	const seeded = 5
	ours := make(map[int64]bool, seeded)
	ids := make([]int64, 0, seeded)
	for i := 0; i < seeded; i++ {
		id := insertLatchShow(t, q, libID, "Rotate "+randomSuffix(t), nil, nil, nil)
		ours[id] = true
		ids = append(ids, id)
	}
	// Remove them promptly as well as on cleanup: a row with no metadata
	// progress sorts to the head of this query's window, so leftovers from an
	// interrupted run are visible to every other package sharing this database.
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM media_items WHERE id = ANY($1)`, ids)
	})

	selectedOurs := func() map[int64]bool {
		t.Helper()
		got, err := q.GetStaleMetadataItems(ctx, refresh)
		if err != nil {
			t.Fatalf("get stale: %v", err)
		}
		out := make(map[int64]bool)
		for _, it := range got {
			if ours[it.ID] {
				out[it.ID] = true
			}
		}
		return out
	}

	// Never touched ⇒ due, and sorted to the head under NULLS FIRST.
	before := selectedOurs()
	if len(before) != seeded {
		t.Fatalf("%d of %d never-touched rows selected; if this is short, the shared test database is holding ~100 never-touched rows from an interrupted run and needs clearing", len(before), seeded)
	}

	// A provider answered about each of them with no match: last_metadata stays
	// NULL because UpdateMediaMetadata was never reached.
	for _, id := range ids {
		if err := q.TouchMetadataAttempt(ctx, id); err != nil {
			t.Fatalf("touch attempt: %v", err)
		}
	}

	// The decisive assertion, and the window-independent one: selection is a
	// WHERE clause, so a row excluded by it cannot appear whatever the LIMIT
	// does. Under the old ordering these rows stay selected for ever and the
	// pass re-reads the same items on every tick.
	if after := selectedOurs(); len(after) != 0 {
		t.Errorf("%d of %d items attempted moments ago are still selected for refresh — they hold the head of the NULLS FIRST queue and starve the rest of the catalog", len(after), seeded)
	}

	// And it is a rotation, not a permanent exclusion: clear one stamp and it
	// comes straight back.
	if _, err := q.pool.Exec(ctx,
		`UPDATE media_items SET last_metadata_attempt = NULL WHERE id = $1`, ids[0]); err != nil {
		t.Fatalf("clear attempt: %v", err)
	}
	if back := selectedOurs(); !back[ids[0]] {
		t.Error("an item with no metadata progress is not selected — the queue would never reach it at all")
	}
}

// The scanner's re-queue query, which exists because the per-file latch could not
// reach the #510 state at all.
//
// processFile returns early when a file's hash is unchanged, BEFORE consulting
// FindMediaItemByTitle — and #510 is precisely "every episode file was recorded and
// flushed, then the deferred enrichment pass was cancelled". So on the next scan
// every file is unchanged and the latch is never evaluated. A round-5 review caught
// that the fix was therefore unreachable in the exact state it targets unless the
// show happened to gain a new or modified file. ScanLibrary now asks this question
// once per scan.
func TestGetUnattemptedShowsForLibrary(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	libID := seedTestLibrary(t, q, seedTestUser(t, q))
	ts := time.Now().Add(-24 * time.Hour)

	// withFiles gives a show a season, an episode and an episode file, which is
	// what makes it a real catalog entry rather than a row awaiting the sweep.
	withFiles := func(itemID int64) {
		t.Helper()
		var seasonID, epID int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1,1) RETURNING id`, itemID).Scan(&seasonID); err != nil {
			t.Fatalf("season: %v", err)
		}
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO tv_episodes (season_id, media_item_id, episode_number) VALUES ($1,$2,1) RETURNING id`,
			seasonID, itemID).Scan(&epID); err != nil {
			t.Fatalf("episode: %v", err)
		}
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO episode_files (episode_id, path, file_hash) VALUES ($1,$2,'h')`,
			epID, "/tmp/unattempted-"+randomSuffix(t)+".mkv"); err != nil {
			t.Fatalf("episode file: %v", err)
		}
	}

	// The #510 row: created, never attempted, all its files on record.
	stuck := insertLatchShow(t, q, libID, "Stuck "+randomSuffix(t), nil, nil, nil)
	withFiles(stuck)
	// Already attempted and unmatched — the rotation's job, not the scanner's.
	attempted := insertLatchShow(t, q, libID, "Attempted "+randomSuffix(t), nil, nil, &ts)
	withFiles(attempted)
	// Already enriched.
	enriched := insertLatchShow(t, q, libID, "Enriched "+randomSuffix(t), nil, &ts, &ts)
	withFiles(enriched)
	// Never attempted but has no files left: about to be swept by
	// DeleteEmptyMediaItems, so enriching it would spend provider calls on a row
	// that is being deleted.
	fileless := insertLatchShow(t, q, libID, "Fileless "+randomSuffix(t), nil, nil, nil)

	got, err := q.GetUnattemptedShowsForLibrary(ctx, libID, 100)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	found := map[int64]string{}
	for _, u := range got {
		found[u.Item.ID] = u.FilePath
	}

	if path, ok := found[stuck]; !ok {
		t.Error("the never-attempted show with files was NOT returned — the scanner has no way to recover it when none of its files changed, which is the #510 state")
	} else if path == "" {
		t.Error("no representative file path returned; enrichNewItem resolves a sibling .nfo from it")
	}
	if _, ok := found[attempted]; ok {
		t.Error("an already-attempted show was returned — the scanner would re-pay a search, a retry and an embed for it on every scan")
	}
	if _, ok := found[enriched]; ok {
		t.Error("an already-enriched show was returned — every scan would re-run its show match")
	}
	if _, ok := found[fileless]; ok {
		t.Error("a show with no episode files was returned — it is one sweep from removal, so enriching it wastes provider calls")
	}

	// The limit is what bounds the sweep's provider cost, and it is the only
	// bound: the predicate is "no metadata PROGRESS", and the attempt stamp is
	// gated on the provider having answered, so a show whose enrichment reliably
	// ERRORS stays eligible for ever. Unbounded, an install with a bad TMDB key
	// re-searched and re-embedded its whole shows library on every scan.
	withFiles(insertLatchShow(t, q, libID, "Stuck Two "+randomSuffix(t), nil, nil, nil))
	capped, err := q.GetUnattemptedShowsForLibrary(ctx, libID, 1)
	if err != nil {
		t.Fatalf("query (limit 1): %v", err)
	}
	if len(capped) != 1 {
		t.Errorf("limit 1 returned %d rows; the sweep is unbounded and re-pays a search per eligible show on every scan", len(capped))
	}
	// ORDER BY id, so which row a capped sweep covers is deterministic rather
	// than whatever the planner returns — the same trade GetStaleMetadataItems'
	// id tiebreaker makes.
	if len(capped) == 1 && capped[0].Item.ID != stuck {
		t.Errorf("capped sweep returned item %d, want the lowest eligible id %d", capped[0].Item.ID, stuck)
	}

	// A non-positive limit is a caller bug, not "no limit" — returning the whole
	// set there would silently restore the unbounded behaviour.
	if _, err := q.GetUnattemptedShowsForLibrary(ctx, libID, 0); err == nil {
		t.Error("limit 0 was accepted; a zero limit must not read as unbounded")
	}
}
