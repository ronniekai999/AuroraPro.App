package db

// Integration coverage for GetSkipMarkerStatus, the admin dashboard's
// skip-marker snapshot. Two properties are load-bearing and were both
// shipped without tests:
//
//   1. analyzed is bounded by its own denominator. media_files' FK is to
//      media_items at large, so a ledger row on a non-movie media_file
//      would count as analyzed while its file never counts as total —
//      rendering 8,178 / 8,177.
//   2. the marker counts are commensurable with the coverage figure and
//      with each other: scoped to the CURRENT detector (bump the detector
//      and coverage resets, so the markers must too), manual is a SUBSET
//      of the kind counts, and zero-length manual rows (migration 043's
//      "admin suppressed this marker") are counted apart from both.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise.
// Shares the harness (requireIntegrationDB / seedTestUser / seedTestLibrary)
// with queries_media_delete_test.go.

import (
	"context"
	"testing"
)

func TestGetSkipMarkerStatusScopesAndClassifies(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, owner)

	const detector = "test-detector-v1"

	item := func(typ, title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title)
			 VALUES ($1, $2, $3, $3) RETURNING id`, libID, typ, title).Scan(&id); err != nil {
			t.Fatalf("insert %s item: %v", typ, err)
		}
		return id
	}
	file := func(itemID int64, path string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_files (media_item_id, path, file_hash)
			 VALUES ($1, $2, 'h') RETURNING id`, itemID, path).Scan(&id); err != nil {
			t.Fatalf("insert media_file: %v", err)
		}
		return id
	}
	analyzed := func(fileID int64, det string) {
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO skip_marker_analysis (media_file_id, detector) VALUES ($1, $2)`,
			fileID, det); err != nil {
			t.Fatalf("insert ledger row: %v", err)
		}
	}
	marker := func(fileID int64, kind string, start, end int64, det string) {
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO skip_markers (media_file_id, kind, start_ms, end_ms, confidence, detector)
			 VALUES ($1, $2, $3, $4, 1, $5)`, fileID, kind, start, end, det); err != nil {
			t.Fatalf("insert marker: %v", err)
		}
	}

	movie := item("movie", "Scoped Movie "+randomSuffix(t))
	movieFile := file(movie, "/tmp/aurora-test/"+randomSuffix(t)+".mkv")
	analyzed(movieFile, detector)

	// The row property (1) defends against: a media_file hanging off a
	// SHOW-typed item, with a ledger entry. No production path creates
	// this today; the query must stay correct if one ever does.
	show := item("show", "Scoped Show "+randomSuffix(t))
	showFile := file(show, "/tmp/aurora-test/"+randomSuffix(t)+".mkv")
	analyzed(showFile, detector)

	marker(movieFile, "intro", 0, 30_000, detector)          // visible, current
	marker(movieFile, "credits", 100_000, 130_000, "manual") // visible, admin-authored
	marker(movieFile, "recap", 0, 0, "manual")               // zero-length => suppressed
	marker(showFile, "credits", 0, 20_000, "stale-v0")       // previous detector version

	got, err := q.GetSkipMarkerStatus(ctx, detector)
	if err != nil {
		t.Fatalf("GetSkipMarkerStatus: %v", err)
	}

	if got.MovieAnalyzed > got.MovieTotal {
		t.Errorf("analyzed (%d) exceeds total (%d): the show-owned media_file leaked into the analyzed count",
			got.MovieAnalyzed, got.MovieTotal)
	}

	// Scoped to this detector (+ manual): the stale-v0 credits marker must
	// not be counted, or a detector bump shows "0 analyzed, N markers".
	if got.CreditsMarkers != 1 {
		t.Errorf("credits = %d, want 1 (the manual one; stale-v0 must be excluded)", got.CreditsMarkers)
	}
	if got.IntroMarkers != 1 {
		t.Errorf("intro = %d, want 1", got.IntroMarkers)
	}
	// The zero-length manual row is a suppression, not a recap marker.
	if got.RecapMarkers != 0 {
		t.Errorf("recap = %d, want 0 (the only recap row is zero-length)", got.RecapMarkers)
	}
	if got.SuppressedMarkers != 1 {
		t.Errorf("suppressed = %d, want 1", got.SuppressedMarkers)
	}
	// manual must be a SUBSET of the kind counts, not disjoint from them:
	// the visible manual credits marker, and not the suppressed recap row.
	if got.ManualMarkers != 1 {
		t.Errorf("manual = %d, want 1 (visible manual markers only)", got.ManualMarkers)
	}
	if kinds := got.IntroMarkers + got.RecapMarkers + got.CreditsMarkers; got.ManualMarkers > kinds {
		t.Errorf("manual (%d) exceeds intro+recap+credits (%d) — it must be a subset, since the tile "+
			"renders it inside that total", got.ManualMarkers, kinds)
	}
}

// Guards the assumption the status query is built on: episode markers and
// movie markers use different columns, and a marker must attach to exactly
// one side. If this ever stops holding, the per-kind counts double-count.
func TestSkipMarkerFileColumnsAreExclusive(t *testing.T) {
	for _, isEpisode := range []bool{true, false} {
		col := skipMarkerFileColumn(isEpisode)
		want := "media_file_id"
		if isEpisode {
			want = "episode_file_id"
		}
		if col != want {
			t.Errorf("skipMarkerFileColumn(%v) = %q, want %q", isEpisode, col, want)
		}
	}
}
