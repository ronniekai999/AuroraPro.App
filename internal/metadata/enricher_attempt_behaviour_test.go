package metadata

// Behavioural coverage for the attempt-stamp gate, driving the real
// Enricher.EnrichMediaItem against a fake TMDB and a real Postgres.
//
// This exists because two successive SYNTACTIC guards over the same invariant
// were each defeated by a review: first a substring check that passed with a
// decoy `if err == nil` beside an ungated call, then an AST check that passed
// with a SHADOWED `err` (`if _, err := ..., error(nil); err == nil`) because it
// matched the identifier by name rather than by binding. A third syntactic
// variant would very likely fall too. Behaviour cannot be fooled that way.
//
// The invariant (issue #510, acceptance criterion 3(b)): last_metadata_attempt
// records "a provider was asked and ANSWERED". An answer with no match must
// stamp it, so the item stops holding the head of GetStaleMetadataItems' NULLS
// FIRST queue and starving the catalog. A failure to reach the provider must NOT
// stamp it, or a single TMDB outage during a scan defers every item it touched by
// a whole refresh interval.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

func attemptTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping attempt-stamp behaviour test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func attemptSuffix(t *testing.T) string {
	t.Helper()
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

// seedShow creates a user, library and one never-touched show, and returns the
// show's id. Everything is reaped via the library/user cascade.
func seedShow(t *testing.T, pool *pgxpool.Pool) *models.MediaItem {
	t.Helper()
	ctx := context.Background()
	sfx := attemptSuffix(t)
	var ownerID, libID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash) VALUES ($1,$2,'x') RETURNING id`,
		"attempt_"+sfx, "attempt_"+sfx+"@example.com").Scan(&ownerID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, ownerID) })
	if err := pool.QueryRow(ctx,
		`INSERT INTO libraries (name, type, paths, owner_id) VALUES ($1,'show',$2,$3) RETURNING id`,
		"attempt_lib_"+sfx, []string{"/tmp/attempt_" + sfx}, ownerID).Scan(&libID); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id=$1`, libID) })

	item := &models.MediaItem{Type: models.MediaShow, Title: "Attempt Probe " + sfx}
	if err := pool.QueryRow(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
		 VALUES ($1,'show',$2,$2,'',0,0,'',0) RETURNING id`, libID, item.Title).Scan(&item.ID); err != nil {
		t.Fatalf("seed item: %v", err)
	}
	item.LibraryID = libID
	return item
}

func readProgress(t *testing.T, pool *pgxpool.Pool, id int64) (lastMetadata, lastAttempt *time.Time) {
	t.Helper()
	if err := pool.QueryRow(context.Background(),
		`SELECT last_metadata, last_metadata_attempt FROM media_items WHERE id = $1`, id).
		Scan(&lastMetadata, &lastAttempt); err != nil {
		t.Fatalf("read progress: %v", err)
	}
	return
}

func TestEnrichMediaItemStampsTheAttemptOnlyWhenTheProviderAnswered(t *testing.T) {
	pool := attemptTestPool(t)
	queries := db.NewQueries(pool)

	t.Run("provider answered with no match: attempt stamped, nothing stored", func(t *testing.T) {
		// A 200 with zero results is "asked and answered, no entry for this
		// title" — the enrich helpers return (0, nil).
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"page":1,"results":[],"total_pages":1,"total_results":0}`))
		}))
		defer srv.Close()

		tmdb := NewTMDBClient("test-key", "en")
		tmdb.baseURL = srv.URL
		// tvdb nil: no fallback, so a zero-result search ends at (0, nil).
		e := NewEnricher(tmdb, nil, queries)

		item := seedShow(t, pool)
		score, err := e.EnrichMediaItem(context.Background(), item)
		if err != nil {
			t.Fatalf("a zero-result search must not be an error, got: %v", err)
		}
		if score != 0 {
			t.Errorf("confidence = %d, want 0 for no match", score)
		}
		lastMetadata, lastAttempt := readProgress(t, pool, item.ID)
		if lastAttempt == nil {
			t.Error("last_metadata_attempt was NOT stamped after the provider answered — the item keeps metadata progress NULL, holds the head of GetStaleMetadataItems' NULLS FIRST queue, and starves every other item in the catalog once 100 such items exist")
		}
		if lastMetadata != nil {
			t.Error("last_metadata was written although nothing was stored — smart diffing would hand TMDB a changes-since date for an item that was never matched")
		}
	})

	t.Run("provider unreachable: attempt NOT stamped", func(t *testing.T) {
		// 401 is returned without retry, so this is fast and unambiguous: we
		// could not get an answer.
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"status_message":"Invalid API key"}`))
		}))
		defer srv.Close()

		tmdb := NewTMDBClient("bad-key", "en")
		tmdb.baseURL = srv.URL
		e := NewEnricher(tmdb, nil, queries)

		item := seedShow(t, pool)
		if _, err := e.EnrichMediaItem(context.Background(), item); err == nil {
			t.Fatal("an unreachable provider must surface an error")
		}
		lastMetadata, lastAttempt := readProgress(t, pool, item.ID)
		if lastAttempt != nil {
			t.Error("last_metadata_attempt WAS stamped although the provider could not be reached — one TMDB outage during a scan would defer every item it touched by a whole refresh interval (acceptance criterion 3(b))")
		}
		if lastMetadata != nil {
			t.Error("last_metadata was written despite the failure")
		}
	})
}
