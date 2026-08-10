package api

// Regression test for the admin Activity tab showing "No recent activity."
// against a log full of entries.
//
// GET /api/admin/activity hand-rolled an `{items, total, ...}` envelope while
// the SPA's listAdminActivity unwraps `.data` and falls back to `|| []`. No
// client ever read `items`, so every row the query returned was discarded in
// the browser and the tab was unconditionally empty — the DB was never the
// problem. The handler now emits the canonical paginatedResponse envelope
// (`{data, page, per_page, total_items, total_pages}`) shared by every other
// paginated endpoint.
//
// These tests decode into the SPA's declared PaginatedResponse<T> shape rather
// than a loose map, so the assertion fails the same way the UI did if the
// envelope key ever drifts again.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run (skipped otherwise),
// mirroring user_role_test.go and social_handlers_test.go.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5/pgxpool"
)

func requireActivityTestDB(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping admin-activity envelope test")
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
	return db.NewQueries(pool), pool
}

// spaActivityEnvelope mirrors the SPA's PaginatedResponse<ActivityEntry>
// (static/redesign/app/src/lib/api.ts) field for field. Decoding through it is
// the point of the test: a server that answers with any other key leaves Data
// nil, exactly as the browser saw it.
type spaActivityEnvelope struct {
	Data       []*models.ActivityEntry `json:"data"`
	Page       int                     `json:"page"`
	PerPage    int                     `json:"per_page"`
	TotalItems int64                   `json:"total_items"`
	TotalPages int                     `json:"total_pages"`
}

// seedActivity inserts n rows under a unique event type and schedules their
// deletion. Filtering by that type keeps the assertions exact on a shared
// database that already holds real logins, scans and streams.
func seedActivity(t *testing.T, q *db.Queries, pool *pgxpool.Pool, n int) string {
	t.Helper()
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	// event_type is VARCHAR(50); this is 25.
	eventType := "test_act_" + hex.EncodeToString(b)

	for i := 0; i < n; i++ {
		entry := &models.ActivityEntry{
			EventType: eventType,
			IPAddress: "203.0.113.7",
			Details:   map[string]interface{}{"seq": i},
		}
		if err := q.InsertActivity(context.Background(), entry); err != nil {
			t.Fatalf("seed activity row %d: %v", i, err)
		}
	}

	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			"DELETE FROM activity_log WHERE event_type = $1", eventType); err != nil {
			t.Logf("cleanup activity rows: %v", err)
		}
	})
	return eventType
}

func getActivity(t *testing.T, h *AdminHandler, query string) (spaActivityEnvelope, string) {
	t.Helper()
	w := httptest.NewRecorder()
	h.Activity(w, httptest.NewRequest(http.MethodGet, "/api/admin/activity?"+query, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/admin/activity?%s: status %d: %s", query, w.Code, w.Body.String())
	}
	body := w.Body.String()
	var env spaActivityEnvelope
	if err := json.Unmarshal([]byte(body), &env); err != nil {
		t.Fatalf("decode envelope: %v (body: %s)", err, body)
	}
	return env, body
}

// TestAdminActivity_EnvelopeMatchesSPAContract is the direct regression: rows
// exist, so the SPA's `.data` unwrap must find them.
func TestAdminActivity_EnvelopeMatchesSPAContract(t *testing.T) {
	q, pool := requireActivityTestDB(t)
	eventType := seedActivity(t, q, pool, 3)
	h := &AdminHandler{queries: q}

	env, body := getActivity(t, h, "type="+eventType+"&per_page=50")

	// The bug in one assertion: before the fix Data was nil here (the rows
	// rode under "items"), which is precisely what rendered the empty tab.
	if len(env.Data) != 3 {
		t.Fatalf("expected 3 entries under `data`, got %d — the SPA unwraps `.data` and would render \"No recent activity.\" (body: %s)", len(env.Data), body)
	}
	for _, e := range env.Data {
		if e.EventType != eventType {
			t.Errorf("type filter leaked a %q row", e.EventType)
		}
	}
	if env.TotalItems != 3 {
		t.Errorf("total_items = %d, want 3", env.TotalItems)
	}
	if env.TotalPages != 1 || env.Page != 1 || env.PerPage != 50 {
		t.Errorf("pagination fields: page=%d per_page=%d total_pages=%d, want 1/50/1",
			env.Page, env.PerPage, env.TotalPages)
	}
}

// TestAdminActivity_LegacyLimitParam pins the ?limit= back-compat path onto the
// same envelope — it shares the response path, so it must not drift separately.
func TestAdminActivity_LegacyLimitParam(t *testing.T) {
	q, pool := requireActivityTestDB(t)
	eventType := seedActivity(t, q, pool, 2)
	h := &AdminHandler{queries: q}

	env, body := getActivity(t, h, "type="+eventType+"&limit=1")

	if len(env.Data) != 1 {
		t.Fatalf("?limit=1 should return 1 entry under `data`, got %d (body: %s)", len(env.Data), body)
	}
	if env.PerPage != 1 || env.Page != 1 {
		t.Errorf("?limit=1 → page=%d per_page=%d, want 1/1", env.Page, env.PerPage)
	}
	// total_items counts the whole filtered set, not the page.
	if env.TotalItems != 2 {
		t.Errorf("total_items = %d, want 2", env.TotalItems)
	}
	if env.TotalPages != 2 {
		t.Errorf("total_pages = %d, want 2", env.TotalPages)
	}
}

// TestAdminActivity_EmptyIsArrayNotNull keeps a genuinely empty log
// serializing as `"data":[]`. A bare `null` would still render the empty
// state, but it makes "no rows" and "wrong key" indistinguishable in a
// response body — the ambiguity that let this bug hide.
func TestAdminActivity_EmptyIsArrayNotNull(t *testing.T) {
	q, _ := requireActivityTestDB(t)
	h := &AdminHandler{queries: q}

	// A type that matches nothing.
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	env, body := getActivity(t, h, "type=test_none_"+hex.EncodeToString(b))

	if len(env.Data) != 0 || env.TotalItems != 0 {
		t.Fatalf("expected an empty result, got %d entries / total_items=%d", len(env.Data), env.TotalItems)
	}
	if !strings.Contains(body, `"data":[]`) {
		t.Errorf("empty activity should serialize as \"data\":[], got: %s", body)
	}
}

// TestAdminActivity_HugePageDoesNotOverflow pins the page clamp. Without it
// (page-1)*per_page overflows int in GetActivityPaginated, Postgres rejects the
// negative OFFSET, and the endpoint 500s on a query param — reachable by any
// admin hand-editing a URL. Review follow-up; the shared paginate() helper caps
// page for exactly this reason.
func TestAdminActivity_HugePageDoesNotOverflow(t *testing.T) {
	q, pool := requireActivityTestDB(t)
	eventType := seedActivity(t, q, pool, 1)
	h := &AdminHandler{queries: q}

	env, _ := getActivity(t, h, "type="+eventType+"&page=9223372036854775807&per_page=100")

	if len(env.Data) != 0 {
		t.Errorf("a page far past the end should be empty, got %d entries", len(env.Data))
	}
	if env.TotalItems != 1 {
		t.Errorf("total_items = %d, want 1 (the count ignores paging)", env.TotalItems)
	}
}
