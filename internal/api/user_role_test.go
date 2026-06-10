package api

// Tests for the admin role-change handler
// (PUT /api/users/{id}/role → AuthHandler.UpdateUserRole).
//
// The input-guard tests (self-change, bad role, unparseable id) return before
// any DB access, so they run unconditionally with a nil queries layer. The
// behavioral tests (promote/demote, 404) need a real row and are opt-in: set
// TEST_DATABASE_URL=postgres://... to run them (skipped otherwise), mirroring
// request_approval_test.go. Each seeds a throwaway user (deleted on cleanup).

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

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func requireRoleTestDB(t *testing.T) *db.Queries {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping role-change DB test")
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

// seedRoleUser inserts a throwaway 'user'-role account and schedules its
// deletion (CASCADE reaps dependents). Returns the user ID.
func seedRoleUser(t *testing.T, q *db.Queries) int64 {
	t.Helper()
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	suffix := hex.EncodeToString(b)
	u, err := q.CreateUser(context.Background(),
		"roletest_"+suffix, "roletest_"+suffix+"@example.test", "x", models.RoleUser)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() { _, _ = q.DeleteUser(context.Background(), u.ID) })
	return u.ID
}

// roleReq builds a PUT request carrying admin claims (actorID), a chi {id} URL
// param, and a JSON role body. idParam lets a test inject a non-numeric id.
func roleReq(actorID int64, idParam, role string) *http.Request {
	r := httptest.NewRequest(http.MethodPut, "/api/users/"+idParam+"/role",
		strings.NewReader(`{"role":"`+role+`"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, &auth.JWTClaims{
		UserID: actorID, Username: "admin", Role: string(models.RoleAdmin),
	}))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", idParam)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// --- input guards: no DB, always run ---

func TestUpdateUserRole_RejectsSelfChange(t *testing.T) {
	// Actor == target must be refused before any DB write so an admin can't
	// strand the server with no admin. queries is nil — the guard returns first.
	h := NewAuthHandler(nil, nil, nil)
	w := httptest.NewRecorder()
	h.UpdateUserRole(w, roleReq(7, "7", "user"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("self-change status = %d, want 400 (body: %s)", w.Code, w.Body.String())
	}
}

func TestUpdateUserRole_RejectsBadRole(t *testing.T) {
	// An unknown role is rejected before UpdateUserRole is called, so nil
	// queries is fine — reaching the DB would panic and fail the test.
	h := NewAuthHandler(nil, nil, nil)
	w := httptest.NewRecorder()
	h.UpdateUserRole(w, roleReq(1, "2", "superuser"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad-role status = %d, want 400 (body: %s)", w.Code, w.Body.String())
	}
}

func TestUpdateUserRole_RejectsUnparseableID(t *testing.T) {
	h := NewAuthHandler(nil, nil, nil)
	w := httptest.NewRecorder()
	h.UpdateUserRole(w, roleReq(1, "not-a-number", "admin"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad-id status = %d, want 400 (body: %s)", w.Code, w.Body.String())
	}
}

// --- behavior: opt-in DB ---

func TestUpdateUserRole_PromoteThenDemote(t *testing.T) {
	q := requireRoleTestDB(t)
	h := NewAuthHandler(nil, q, nil)
	const adminID = int64(1) // distinct from the seeded target
	target := seedRoleUser(t, q)

	// Promote → admin.
	w := httptest.NewRecorder()
	h.UpdateUserRole(w, roleReq(adminID, strconv.FormatInt(target, 10), "admin"))
	if w.Code != http.StatusOK {
		t.Fatalf("promote status = %d, want 200 (body: %s)", w.Code, w.Body.String())
	}
	if got, err := q.GetUserByID(context.Background(), target); err != nil || got.Role != models.RoleAdmin {
		t.Fatalf("after promote role = %v (err %v), want admin", got.Role, err)
	}

	// Demote → user.
	w = httptest.NewRecorder()
	h.UpdateUserRole(w, roleReq(adminID, strconv.FormatInt(target, 10), "user"))
	if w.Code != http.StatusOK {
		t.Fatalf("demote status = %d, want 200 (body: %s)", w.Code, w.Body.String())
	}
	if got, err := q.GetUserByID(context.Background(), target); err != nil || got.Role != models.RoleUser {
		t.Fatalf("after demote role = %v (err %v), want user", got.Role, err)
	}
}

func TestUpdateUserRole_MissingUserIs404(t *testing.T) {
	q := requireRoleTestDB(t)
	h := NewAuthHandler(nil, q, nil)
	w := httptest.NewRecorder()
	h.UpdateUserRole(w, roleReq(1, "999999999", "admin"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing-user status = %d, want 404 (body: %s)", w.Code, w.Body.String())
	}
}
