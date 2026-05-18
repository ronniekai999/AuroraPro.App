package db

// Integration tests covering the JSONB-serialization regression that hit
// production on 2026-05-15: pgx serializes Go `string` as Postgres `text`,
// and Postgres 16+ refuses the implicit cast to a `jsonb` column.
// Manifested as: `column "settings_json" is of type jsonb but expression
// is of type text (SQLSTATE 42804)`.
//
// Fix lives in queries_rooms.go (InsertRoom) and queries_parties.go
// (InsertWatchParty) — both wrap the parameter in
// `COALESCE(NULLIF($N, ''), '{}')::jsonb`. These tests pin the fix
// against a live Postgres so the bug can't regress under future schema
// or pgx changes.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run. Skipped when
// unset so the unit-test suite stays standalone.
//
// Operator note: the test creates+deletes a temporary user, library,
// and media_item per test run. Cleanup runs even on failure (t.Cleanup).
// Run against a dev DB; do NOT point this at production.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5/pgxpool"
)

// requireIntegrationDB returns a *Queries against TEST_DATABASE_URL, or
// skips the test if the env var is unset. The connection pool is
// registered for cleanup via t.Cleanup. Schema is assumed to already be
// migrated (operator's responsibility; run `aurora` once against the
// test DB or use `psql -f migrations/*.up.sql`).
func requireIntegrationDB(t *testing.T) *Queries {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to test db: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping test db: %v", err)
	}
	t.Cleanup(pool.Close)
	return NewQueries(pool)
}

// randomSuffix returns a hex string for namespacing test fixtures so
// parallel runs don't collide on `users.username UNIQUE`.
func randomSuffix(t *testing.T) string {
	t.Helper()
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

// seedTestUser inserts a temporary user satisfying the FK from
// watch_party_rooms.owner_user_id and watch_parties.host_user_id.
// Cleanup deletes by id. ON DELETE CASCADE on the FKs means any rows
// we create that reference this user get cleaned up too — defense in
// depth if a test forgets a cleanup.
func seedTestUser(t *testing.T, q *Queries) int64 {
	t.Helper()
	suffix := randomSuffix(t)
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO users (username, email, password_hash)
		 VALUES ($1, $2, $3) RETURNING id`,
		"jsonb_test_"+suffix,
		"jsonb_test_"+suffix+"@example.com",
		"$2a$10$placeholder",
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// seedTestLibrary + seedTestMediaItem satisfy the FK from
// watch_parties.media_item_id. CASCADE on libraries means deleting the
// library reaps the media item; we register both for symmetry.
func seedTestLibrary(t *testing.T, q *Queries, ownerID int64) int64 {
	t.Helper()
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO libraries (name, type, paths, owner_id)
		 VALUES ($1, 'movie', $2, $3) RETURNING id`,
		"jsonb_test_lib_"+randomSuffix(t),
		[]string{"/tmp/jsonb_test"},
		ownerID,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM libraries WHERE id = $1`, id)
	})
	return id
}

func seedTestMediaItem(t *testing.T, q *Queries, libraryID int64) int64 {
	t.Helper()
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO media_items (library_id, type, title, sort_title)
		 VALUES ($1, 'movie', $2, $2) RETURNING id`,
		libraryID,
		"JSONB Test Movie "+randomSuffix(t),
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed media item: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM media_items WHERE id = $1`, id)
	})
	return id
}

// TestInsertRoom_JSONBSerialization pins the exact regression: an
// InsertRoom call with a `string` SettingsJSON should succeed against a
// real `JSONB` column. Pre-fix, this returned SQLSTATE 42804.
func TestInsertRoom_JSONBSerialization(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)

	cases := []struct {
		name     string
		settings string
		wantSet  bool // expect non-empty SettingsJSON on round-trip read
	}{
		// The production crash path: zero-value SettingsJSON (empty
		// string from Go). NULLIF normalizes to NULL → COALESCE picks
		// '{}' → cast lands in the JSONB column. Pre-fix: 42804.
		{name: "empty string defaults to empty object", settings: "", wantSet: true},
		// A valid JSON object — the typical "AllowPause/AllowChat"
		// payload from PartySettings marshaling.
		{name: "explicit empty object", settings: `{}`, wantSet: true},
		// A non-trivial payload — exercises the full pgx → JSONB path
		// rather than just the COALESCE default branch.
		{name: "non-trivial settings", settings: `{"allow_pause":true,"allow_chat":false,"spoiler_free_start":true}`, wantSet: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			room := &models.WatchPartyRoom{
				Code:         "T" + randomSuffix(t)[:5], // 6 chars, no collision with running parties
				Name:         "JSONB Test Room",
				OwnerUserID:  ownerID,
				IsPersistent: false,
				SettingsJSON: tc.settings,
			}
			if err := q.InsertRoom(context.Background(), room); err != nil {
				t.Fatalf("InsertRoom failed (the bug we fixed): %v", err)
			}
			t.Cleanup(func() {
				_, _ = q.pool.Exec(context.Background(), `DELETE FROM watch_party_rooms WHERE id = $1`, room.ID)
			})
			if room.ID == 0 {
				t.Fatal("InsertRoom didn't populate room.ID")
			}
			// Read it back via GetRoomByID to verify the column landed
			// as valid JSONB (not just "the insert didn't error").
			fetched, err := q.GetRoomByID(context.Background(), room.ID)
			if err != nil {
				t.Fatalf("GetRoomByID after InsertRoom: %v", err)
			}
			if fetched == nil {
				t.Fatalf("GetRoomByID returned nil for room we just inserted")
			}
			if tc.wantSet && fetched.SettingsJSON == "" {
				t.Errorf("expected non-empty SettingsJSON round-trip, got empty")
			}
		})
	}
}

// TestInsertWatchParty_JSONBSerialization pins the same fix on the
// parties insert (queries_parties.go). The bug was masked in production
// because InsertRoom failed first and short-circuited the CreateParty
// flow; this test exercises InsertWatchParty directly.
func TestInsertWatchParty_JSONBSerialization(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	libraryID := seedTestLibrary(t, q, ownerID)
	mediaItemID := seedTestMediaItem(t, q, libraryID)

	// Also seed a room so the party's room_id FK is satisfied (M3 made
	// every party belong to a room).
	room := &models.WatchPartyRoom{
		Code:         "P" + randomSuffix(t)[:5],
		OwnerUserID:  ownerID,
		IsPersistent: false,
		SettingsJSON: `{}`,
	}
	if err := q.InsertRoom(context.Background(), room); err != nil {
		t.Fatalf("seed room for party FK: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM watch_party_rooms WHERE id = $1`, room.ID)
	})

	cases := []struct {
		name     string
		settings string
	}{
		{name: "empty string", settings: ""},
		{name: "explicit empty object", settings: `{}`},
		{name: "non-trivial settings", settings: `{"allow_pause":true,"allow_chat":true}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Each subtest needs its own party_code: watch_parties has a
			// partial unique index on (party_code) WHERE is_active=true,
			// and subtest cleanups run LIFO at the END of the parent
			// test — so subtest 2 would otherwise collide with subtest
			// 1's still-active row. The room.Code that the FK depends
			// on is the ROOM's code, which is independent of the
			// PARTY's party_code despite the M3 convention of mirroring
			// them in production. (Audit-flagged 2026-05-15.)
			party := &models.WatchParty{
				PartyCode:       "Q" + randomSuffix(t)[:5],
				HostUserID:      ownerID,
				MediaItemID:     mediaItemID,
				PartyName:       "JSONB Test Party",
				MediaTitle:      "JSONB Test Movie",
				MaxParticipants: 10,
				IsActive:        true,
				SettingsJSON:    tc.settings,
				CreatedAt:       time.Now(),
				RoomID:          &room.ID,
			}
			if err := q.InsertWatchParty(context.Background(), party); err != nil {
				t.Fatalf("InsertWatchParty failed (the bug we fixed): %v", err)
			}
			t.Cleanup(func() {
				_, _ = q.pool.Exec(context.Background(), `DELETE FROM watch_parties WHERE id = $1`, party.ID)
			})
			if party.ID == 0 {
				t.Fatal("InsertWatchParty didn't populate party.ID")
			}
		})
	}
}
