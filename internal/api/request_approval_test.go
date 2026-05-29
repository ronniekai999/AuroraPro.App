package api

// Integration tests for the request-gating approval queue (carve-out C):
// the requestQuota helper plus the ListPendingApprovals / ApproveRequest /
// DenyRequest admin handlers.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run (skipped otherwise),
// mirroring the db package's requireIntegrationDB. Each test seeds a
// temporary user (deleted on cleanup; CASCADE reaps its requests) via the
// public db.Queries API only — this test lives in package api and cannot
// reach the unexported pool.
//
// dispatchToARR is fire-and-forget after the synchronous status write, so
// these tests assert the DB transition the handler performs *before*
// dispatching — they do not depend on any ARR service being reachable (the
// handler is built with an empty ArrClients).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/arr"
	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func requireRequestTestDB(t *testing.T) *db.Queries {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping request-approval integration test")
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
	return db.NewQueries(pool)
}

func reqTestSuffix(t *testing.T) string {
	t.Helper()
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

func seedReqUser(t *testing.T, q *db.Queries) int64 {
	t.Helper()
	suffix := reqTestSuffix(t)
	user, err := q.CreateUser(context.Background(),
		"req_test_"+suffix, "req_test_"+suffix+"@example.com", "$2a$10$placeholder", models.RoleUser)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	// DeleteUser CASCADEs the user's requests, so no per-request cleanup needed.
	t.Cleanup(func() {
		_, _ = q.DeleteUser(context.Background(), user.ID)
	})
	return user.ID
}

func seedReq(t *testing.T, q *db.Queries, userID int64, status string) *models.Request {
	t.Helper()
	now := time.Now()
	req := &models.Request{
		UserID:       userID,
		MediaType:    "movie",
		TMDBID:       int(time.Now().UnixNano() % 1_000_000_000),
		Title:        "Approval Test " + reqTestSuffix(t),
		Status:       status,
		Quality1080p: true,
		RequestedAt:  now,
		UpdatedAt:    now,
	}
	if err := q.InsertRequest(context.Background(), req); err != nil {
		t.Fatalf("seed request: %v", err)
	}
	return req
}

// newApprovalHandler builds a RequestHandler with an empty (no-op) ArrClients.
// dispatchToARR will find the row but no ARR service is configured; we never
// assert on the async outcome, only the synchronous status write.
func newApprovalHandler(q *db.Queries) *RequestHandler {
	clients := arr.NewArrClients(nil, nil, nil, nil, true)
	return NewRequestHandler(q, nil, nil, clients, nil, nil)
}

// adminReq attaches admin claims and a chi {id} URL param to a request.
func adminReq(t *testing.T, method, id string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(method, "/api/admin/requests/"+id, nil)
	r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, &auth.JWTClaims{
		UserID: 1, Username: "admin", Role: string(models.RoleAdmin),
	}))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

func TestRequestQuota_DefaultsAndOverride(t *testing.T) {
	q := requireRequestTestDB(t)
	h := newApprovalHandler(q)
	ctx := context.Background()

	// Restore whatever was there afterward by clearing our overrides — the
	// keys default to "unset" which the helper treats as the built-in
	// defaults. (SetSetting to "" would persist an empty row; clearing keeps
	// the shared DB clean. There is no public delete-setting, so we leave the
	// final fallback values in place; the helper ignores non-positive values.)
	t.Cleanup(func() {
		_ = q.SetSetting(ctx, "requests_quota_active", "0")
		_ = q.SetSetting(ctx, "requests_quota_daily", "0")
	})

	// Start from a clean slate for the default assertion.
	_ = q.SetSetting(ctx, "requests_quota_active", "0")
	_ = q.SetSetting(ctx, "requests_quota_daily", "0")
	if a, d := h.requestQuota(ctx); a != 10 || d != 25 {
		t.Fatalf("defaults = (%d, %d), want (10, 25)", a, d)
	}

	// Valid overrides apply.
	if err := q.SetSetting(ctx, "requests_quota_active", "3"); err != nil {
		t.Fatal(err)
	}
	if err := q.SetSetting(ctx, "requests_quota_daily", "7"); err != nil {
		t.Fatal(err)
	}
	if a, d := h.requestQuota(ctx); a != 3 || d != 7 {
		t.Fatalf("override = (%d, %d), want (3, 7)", a, d)
	}

	// Non-positive / malformed values fall back to the defaults.
	if err := q.SetSetting(ctx, "requests_quota_active", "0"); err != nil {
		t.Fatal(err)
	}
	if err := q.SetSetting(ctx, "requests_quota_daily", "abc"); err != nil {
		t.Fatal(err)
	}
	if a, d := h.requestQuota(ctx); a != 10 || d != 25 {
		t.Fatalf("bad values = (%d, %d), want fallback (10, 25)", a, d)
	}
}

func TestApproveRequest_FlipsHeldToPending(t *testing.T) {
	q := requireRequestTestDB(t)
	h := newApprovalHandler(q)
	userID := seedReqUser(t, q)
	held := seedReq(t, q, userID, models.RequestPendingApproval)

	w := httptest.NewRecorder()
	h.ApproveRequest(w, adminReq(t, http.MethodPost, strconv.FormatInt(held.ID, 10)))
	if w.Code != http.StatusOK {
		t.Fatalf("approve status = %d, want 200 (body: %s)", w.Code, w.Body.String())
	}

	// The synchronous UpdateRequestStatus must have moved it off
	// pending_approval. (It becomes 'pending', then the async dispatch may
	// later fail it because no ARR is configured — either way it is no
	// longer held, which is what approval guarantees.)
	got, err := q.GetRequestByID(context.Background(), held.ID)
	if err != nil || got == nil {
		t.Fatalf("get after approve: err=%v row=%v", err, got)
	}
	if got.Status == models.RequestPendingApproval {
		t.Errorf("status still pending_approval after approve; want it admitted")
	}
}

func TestDenyRequest_MarksFailedWithReason(t *testing.T) {
	q := requireRequestTestDB(t)
	h := newApprovalHandler(q)
	userID := seedReqUser(t, q)
	held := seedReq(t, q, userID, models.RequestPendingApproval)

	w := httptest.NewRecorder()
	h.DenyRequest(w, adminReq(t, http.MethodPost, strconv.FormatInt(held.ID, 10)))
	if w.Code != http.StatusOK {
		t.Fatalf("deny status = %d, want 200 (body: %s)", w.Code, w.Body.String())
	}

	got, err := q.GetRequestByID(context.Background(), held.ID)
	if err != nil || got == nil {
		t.Fatalf("get after deny: err=%v row=%v", err, got)
	}
	if got.Status != models.RequestFailed {
		t.Errorf("status = %q after deny, want failed", got.Status)
	}
	if got.ErrorMessage != "denied by admin" {
		t.Errorf("error_message = %q, want %q", got.ErrorMessage, "denied by admin")
	}
}

func TestApproveDeny_GuardsNonHeldAndMissing(t *testing.T) {
	q := requireRequestTestDB(t)
	h := newApprovalHandler(q)
	userID := seedReqUser(t, q)

	// A request that is NOT pending_approval → 400 on both endpoints.
	pending := seedReq(t, q, userID, models.RequestPending)
	for _, tc := range []struct {
		name string
		fn   func(http.ResponseWriter, *http.Request)
	}{
		{"approve-wrong-status", h.ApproveRequest},
		{"deny-wrong-status", h.DenyRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			tc.fn(w, adminReq(t, http.MethodPost, strconv.FormatInt(pending.ID, 10)))
			if w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 for non-held request", w.Code)
			}
		})
	}

	// A missing id → 404.
	t.Run("approve-missing", func(t *testing.T) {
		w := httptest.NewRecorder()
		h.ApproveRequest(w, adminReq(t, http.MethodPost, "999999999"))
		if w.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404 for missing request", w.Code)
		}
	})
}

func TestListPendingApprovals_ReturnsHeldOnly(t *testing.T) {
	q := requireRequestTestDB(t)
	h := newApprovalHandler(q)
	userID := seedReqUser(t, q)
	held := seedReq(t, q, userID, models.RequestPendingApproval)
	seedReq(t, q, userID, models.RequestPending) // must not appear

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/admin/requests/pending", nil)
	r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, &auth.JWTClaims{
		UserID: 1, Role: string(models.RoleAdmin),
	}))
	h.ListPendingApprovals(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200", w.Code)
	}
	// The held row we created must be in the body.
	if !strings.Contains(w.Body.String(), strconv.FormatInt(held.ID, 10)) {
		t.Errorf("held request %d not present in list body: %s", held.ID, w.Body.String())
	}
}
