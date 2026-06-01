package db

// Tests for the has_hdr browse badge query (GetMediaItemsWithHDR +
// GetMediaItemsWithHDRCrossLibrary). HDR is detected via the ffprobe
// color_transfer column (smpte2084 = PQ/HDR10, arib-std-b67 = HLG),
// mirroring the has_4k query but keyed on color metadata rather than
// version_tag (release tags don't reliably carry HDR).
//
// Opt-in integration: set TEST_DATABASE_URL=postgres://... to run.
// Skipped when unset (reuses requireIntegrationDB from the jsonb test),
// so the standalone unit suite stays DB-free. Reuses seedTestUser /
// seedTestLibrary / seedTestMediaItem from queries_jsonb_integration_test.go.

import (
	"context"
	"testing"
)

// TestHDRColorTransfers_ContractWithFrontend is a pure unit test (no DB):
// the set of color_transfer values the backend treats as HDR must stay in
// lock-step with the frontend's formatHdr() in lib/detail.ts. If someone
// adds e.g. Dolby-Vision's transfer here, they must add it there too (and
// vice-versa) or the browse badge and the detail quality chip disagree.
func TestHDRColorTransfers_ContractWithFrontend(t *testing.T) {
	want := map[string]bool{"smpte2084": true, "arib-std-b67": true}
	if len(hdrColorTransfers) != len(want) {
		t.Fatalf("hdrColorTransfers has %d entries (%v), want %d — keep in sync with formatHdr() in lib/detail.ts",
			len(hdrColorTransfers), hdrColorTransfers, len(want))
	}
	for _, v := range hdrColorTransfers {
		if !want[v] {
			t.Errorf("unexpected color_transfer %q in hdrColorTransfers — if intentional, update formatHdr() in lib/detail.ts too", v)
		}
	}
}

// seedMediaFile inserts one media_files row with the given color_transfer
// and registers cleanup. path + file_hash are namespaced so parallel runs
// don't collide on the UNIQUE(path) constraint.
func seedMediaFile(t *testing.T, q *Queries, mediaItemID int64, colorTransfer string) {
	t.Helper()
	suffix := randomSuffix(t)
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO media_files (media_item_id, path, file_hash, color_transfer)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		mediaItemID,
		"/tmp/hdr_test/"+suffix+".mkv",
		"hash_"+suffix,
		colorTransfer,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed media_file: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM media_files WHERE id = $1`, id)
	})
}

// TestGetMediaItemsWithHDR pins the direct (non-cross-library) detection:
// a media item with an smpte2084 / arib-std-b67 file is HDR; one with only
// bt709 or an empty transfer is not.
func TestGetMediaItemsWithHDR(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	libraryID := seedTestLibrary(t, q, ownerID)

	pq := seedTestMediaItem(t, q, libraryID)   // HDR10 (PQ)
	hlg := seedTestMediaItem(t, q, libraryID)  // HLG
	sdr := seedTestMediaItem(t, q, libraryID)  // bt709
	none := seedTestMediaItem(t, q, libraryID) // empty transfer (unscanned)
	mixed := seedTestMediaItem(t, q, libraryID) // one SDR + one HDR file → HDR

	seedMediaFile(t, q, pq, "smpte2084")
	seedMediaFile(t, q, hlg, "arib-std-b67")
	seedMediaFile(t, q, sdr, "bt709")
	seedMediaFile(t, q, none, "")
	seedMediaFile(t, q, mixed, "bt709")
	seedMediaFile(t, q, mixed, "smpte2084")

	got, err := q.GetMediaItemsWithHDR(context.Background(), []int64{pq, hlg, sdr, none, mixed})
	if err != nil {
		t.Fatalf("GetMediaItemsWithHDR: %v", err)
	}

	for _, id := range []int64{pq, hlg, mixed} {
		if !got[id] {
			t.Errorf("media item %d should be flagged HDR", id)
		}
	}
	for _, id := range []int64{sdr, none} {
		if got[id] {
			t.Errorf("media item %d should NOT be flagged HDR", id)
		}
	}
}

// TestGetMediaItemsWithHDRCrossLibrary pins the sibling logic: an item
// with no HDR file of its own still gets the badge if a same-tmdb_id
// sibling in another library has one (mirrors the 4K cross-library badge).
func TestGetMediaItemsWithHDRCrossLibrary(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	libA := seedTestLibrary(t, q, ownerID)
	libB := seedTestLibrary(t, q, ownerID)

	// Two media items sharing a tmdb_id across libraries: A is SDR, B is
	// HDR. Cross-library detection should light up BOTH. Use the seeded
	// item ids to derive a collision-free tmdb_id for this run.
	itemA := seedTestMediaItem(t, q, libA)
	itemB := seedTestMediaItem(t, q, libB)
	tmdbID := 900000000 + itemA // unique per run; > any real TMDB id seeded elsewhere
	if _, err := q.pool.Exec(context.Background(),
		`UPDATE media_items SET tmdb_id = $1 WHERE id = ANY($2)`, tmdbID, []int64{itemA, itemB}); err != nil {
		t.Fatalf("set tmdb_id: %v", err)
	}
	seedMediaFile(t, q, itemA, "bt709")     // SDR
	seedMediaFile(t, q, itemB, "smpte2084") // HDR sibling

	got, err := q.GetMediaItemsWithHDRCrossLibrary(context.Background(), []int64{itemA, itemB})
	if err != nil {
		t.Fatalf("GetMediaItemsWithHDRCrossLibrary: %v", err)
	}
	if !got[itemA] {
		t.Errorf("item %d should inherit HDR from its cross-library sibling", itemA)
	}
	if !got[itemB] {
		t.Errorf("item %d should be flagged HDR directly", itemB)
	}
}
