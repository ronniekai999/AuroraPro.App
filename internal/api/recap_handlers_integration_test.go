package api

// Opt-in HTTP integration coverage for Ask Previously. Set TEST_DATABASE_URL
// to a fully migrated development database; fixtures are isolated and cascade
// away with their owning users.

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAskPreviouslyHTTPIdempotencyOwnershipAndRateLimit(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	t.Cleanup(pool.Close)
	q := db.NewQueries(pool)

	seedUser := func(suffix string) int64 {
		var id int64
		err := pool.QueryRow(ctx, `
			INSERT INTO users (username, email, password_hash)
			VALUES ($1, $2, '$2a$10$placeholder') RETURNING id`,
			"ask_http_"+suffix, "ask_http_"+suffix+"@example.test").Scan(&id)
		if err != nil {
			t.Fatalf("seed user %s: %v", suffix, err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id) })
		return id
	}
	userID := seedUser(fmt.Sprintf("%d", time.Now().UnixNano()))
	otherUserID := seedUser(fmt.Sprintf("other_%d", time.Now().UnixNano()))

	var libraryID, profileID, otherProfileID, mediaID, seasonID, episodeID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO libraries (name, type, paths, owner_id)
		VALUES ('Ask HTTP', 'movie', ARRAY['/tmp/ask-http'], $1) RETURNING id`, userID).Scan(&libraryID); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO user_profiles (user_id, name, is_default)
		VALUES ($1, 'Viewer', TRUE) RETURNING id`, userID).Scan(&profileID); err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO user_profiles (user_id, name, is_default)
		VALUES ($1, 'Other viewer', TRUE) RETURNING id`, otherUserID).Scan(&otherProfileID); err != nil {
		t.Fatalf("seed other profile: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO media_items (library_id, type, title, sort_title)
		VALUES ($1, 'show', 'Ask HTTP Show', 'Ask HTTP Show') RETURNING id`, libraryID).Scan(&mediaID); err != nil {
		t.Fatalf("seed show: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO tv_seasons (media_item_id, season_number)
		VALUES ($1, 1) RETURNING id`, mediaID).Scan(&seasonID); err != nil {
		t.Fatalf("seed season: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO tv_episodes (season_id, media_item_id, episode_number, title, overview)
		VALUES ($1, $2, 1, 'Pilot', 'A safe synopsis.') RETURNING id`, seasonID, mediaID).Scan(&episodeID); err != nil {
		t.Fatalf("seed episode: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO watch_progress (user_id, profile_id, media_item_id, episode_id, completed)
		VALUES ($1, $2, $3, $4, TRUE)`, userID, profileID, mediaID, episodeID); err != nil {
		t.Fatalf("seed progress: %v", err)
	}

	requestID := "550e8400-e29b-41d4-a716-446655440000"
	question := "Who matters?"
	questionHash := recapQuestionHash(question)
	reservation, err := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
		requestID, questionHash, 2*time.Minute, 100, time.Hour)
	if err != nil {
		t.Fatalf("reserve stored answer: %v", err)
	}
	boundary := &db.RecapBoundary{EpisodeID: episodeID, SeasonNumber: 1, EpisodeNumber: 1, Title: "Pilot"}
	if _, _, err := q.InsertRecapConversationTurn(ctx, reservation.ID, profileID, mediaID,
		requestID, questionHash, question, "The lead matters. Their choice drives the pilot.", boundary, "caught-up"); err != nil {
		t.Fatalf("insert stored answer: %v", err)
	}

	handler := NewRecapHandler(q, nil) // provider deliberately disabled
	response := callAskPreviouslyHTTP(handler, userID, mediaID, profileID,
		fmt.Sprintf(`{"request_id":%q,"question":%q}`, requestID, question))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "The lead matters") {
		t.Fatalf("completed retry with provider disabled: status=%d body=%s", response.Code, response.Body.String())
	}
	conflict := callAskPreviouslyHTTP(handler, userID, mediaID, profileID,
		fmt.Sprintf(`{"request_id":%q,"question":"Different question"}`, requestID))
	if conflict.Code != http.StatusConflict {
		t.Fatalf("changed idempotency key status=%d body=%s", conflict.Code, conflict.Body.String())
	}
	forbidden := callAskPreviouslyHTTP(handler, userID, mediaID, otherProfileID,
		`{"request_id":"bb7f4972-aad7-4b9b-8f40-d1ce11bc3d52","question":"Private?"}`)
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("foreign profile status=%d body=%s", forbidden.Code, forbidden.Body.String())
	}

	// Failed provider attempts remain new questions and consume one durable
	// account-wide slot each; the 21st is rejected with Retry-After.
	if _, err := pool.Exec(ctx, `DELETE FROM recap_question_rate_events WHERE user_id = $1`, userID); err != nil {
		t.Fatalf("reset rate events: %v", err)
	}
	for i := 0; i < defaultRecapAskRate; i++ {
		id := fmt.Sprintf("20000000-0000-4000-8000-%012x", i+1)
		result := callAskPreviouslyHTTP(handler, userID, mediaID, profileID,
			fmt.Sprintf(`{"request_id":%q,"question":"Question %d?"}`, id, i+1))
		if result.Code != http.StatusServiceUnavailable {
			t.Fatalf("provider-disabled request %d status=%d body=%s", i, result.Code, result.Body.String())
		}
	}
	limited := callAskPreviouslyHTTP(handler, userID, mediaID, profileID,
		`{"request_id":"30000000-0000-4000-8000-000000000001","question":"One too many?"}`)
	if limited.Code != http.StatusTooManyRequests || limited.Header().Get("Retry-After") == "" {
		t.Fatalf("rate limit status=%d retry-after=%q body=%s", limited.Code, limited.Header().Get("Retry-After"), limited.Body.String())
	}
}

func callAskPreviouslyHTTP(handler *RecapHandler, userID, mediaID, profileID int64, body string) *httptest.ResponseRecorder {
	target := fmt.Sprintf("/api/media/%d/recap/conversation/turns?profile_id=%d", mediaID, profileID)
	request := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", fmt.Sprintf("%d", mediaID))
	ctx := context.WithValue(request.Context(), chi.RouteCtxKey, routeContext)
	ctx = context.WithValue(ctx, auth.ClaimsContextKey, &auth.JWTClaims{UserID: userID, Username: "ask-http", Role: "user"})
	response := httptest.NewRecorder()
	handler.AskTurn(response, request.WithContext(ctx))
	return response
}
