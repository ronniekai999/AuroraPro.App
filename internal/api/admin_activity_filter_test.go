package api

// Tests for the admin Activity tab's event-type filter: the ?type= parameter
// on GET /api/admin/activity, and GET /api/admin/activity/types which supplies
// the dropdown's options.
//
// The option list is derived from the data rather than a constant because
// event types are registered ad hoc at ~24 call sites with no central
// registry. That makes "the endpoint reports what was actually written" the
// property worth pinning — a hardcoded list would pass a test and still drift
// in production.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run (skipped otherwise),
// sharing the helpers in admin_activity_envelope_test.go.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedActivityType inserts n rows under an exact event type and schedules
// their deletion. Distinct from seedActivity, which picks the type itself.
func seedActivityType(t *testing.T, q *db.Queries, pool *pgxpool.Pool, eventType string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if err := q.InsertActivity(context.Background(), &models.ActivityEntry{
			EventType: eventType,
		}); err != nil {
			t.Fatalf("seed %s row %d: %v", eventType, i, err)
		}
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			"DELETE FROM activity_log WHERE event_type = $1", eventType); err != nil {
			t.Logf("cleanup %s: %v", eventType, err)
		}
	})
}

// activityTypePair returns two event types sharing a random prefix, ordered so
// that aType < bType lexicographically. The shared prefix keeps them
// identifiable on a database that also holds real rows.
func activityTypePair(t *testing.T) (string, string) {
	t.Helper()
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	// 9 + 12 + 2 = 23 chars, inside event_type's VARCHAR(50).
	prefix := "test_flt_" + hex.EncodeToString(b)
	return prefix + "_a", prefix + "_b"
}

func getActivityTypes(t *testing.T, h *AdminHandler) []*models.ActivityEventType {
	t.Helper()
	w := httptest.NewRecorder()
	h.ActivityTypes(w, httptest.NewRequest(http.MethodGet, "/api/admin/activity/types", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/admin/activity/types: status %d: %s", w.Code, w.Body.String())
	}
	// Pin the flat `{items: […]}` shape the SPA's listAdminActivityTypes
	// reads. Decoding through the client's contract is deliberate: the empty
	// Activity tab this filter was built on top of was an envelope mismatch
	// that every status-only check passed.
	var env struct {
		Items []*models.ActivityEventType `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v (body: %s)", err, w.Body.String())
	}
	if env.Items == nil {
		t.Fatalf("no `items` key in response — the SPA reads it: %s", w.Body.String())
	}
	return env.Items
}

// TestAdminActivityTypes_ReportsDistinctTypesWithCounts pins the dropdown's
// data source: one row per distinct type, counted, alphabetically ordered.
func TestAdminActivityTypes_ReportsDistinctTypesWithCounts(t *testing.T) {
	q, pool := requireActivityTestDB(t)
	aType, bType := activityTypePair(t)
	seedActivityType(t, q, pool, aType, 3)
	seedActivityType(t, q, pool, bType, 1)
	h := &AdminHandler{queries: q}

	var gotA, gotB *models.ActivityEventType
	var idxA, idxB = -1, -1
	for i, ty := range getActivityTypes(t, h) {
		switch ty.EventType {
		case aType:
			gotA, idxA = ty, i
		case bType:
			gotB, idxB = ty, i
		}
	}

	if gotA == nil || gotB == nil {
		t.Fatalf("seeded types missing from the option list (a=%v b=%v)", gotA, gotB)
	}
	// Grouped, not one row per entry — three seeded rows collapse to one
	// option carrying count 3.
	if gotA.Count != 3 {
		t.Errorf("count for %s = %d, want 3", aType, gotA.Count)
	}
	if gotB.Count != 1 {
		t.Errorf("count for %s = %d, want 1", bType, gotB.Count)
	}
	// Alphabetical, so an option keeps a stable position as counts move.
	// The 3-row type sorts BEFORE the 1-row type, which frequency ordering
	// would also satisfy — the suffixes make this assertion discriminating.
	if idxA > idxB {
		t.Errorf("options not alphabetical: %s at %d came after %s at %d", aType, idxA, bType, idxB)
	}
}

// TestAdminActivityTypes_OmitsTypesWithNoRows is the property that makes
// deriving the list worthwhile: a type nobody has recorded is not offered, and
// one that appears later shows up without a code change.
func TestAdminActivityTypes_OmitsTypesWithNoRows(t *testing.T) {
	q, pool := requireActivityTestDB(t)
	aType, bType := activityTypePair(t)
	seedActivityType(t, q, pool, aType, 1)
	h := &AdminHandler{queries: q}

	has := func(want string) bool {
		for _, ty := range getActivityTypes(t, h) {
			if ty.EventType == want {
				return true
			}
		}
		return false
	}

	if !has(aType) {
		t.Errorf("recorded type %s absent from options", aType)
	}
	if has(bType) {
		t.Errorf("unrecorded type %s offered as an option", bType)
	}

	// Record one and it appears — no restart, no constant to update.
	seedActivityType(t, q, pool, bType, 1)
	if !has(bType) {
		t.Errorf("newly recorded type %s still absent from options", bType)
	}
}

// TestAdminActivity_TypeFilterIsExclusive pins the filter the dropdown drives.
// Filtering must happen server-side: a client-side filter over the loaded page
// would search only the newest 50 rows, so a rare event would read as empty
// while older matches sat one page back.
func TestAdminActivity_TypeFilterIsExclusive(t *testing.T) {
	q, pool := requireActivityTestDB(t)
	aType, bType := activityTypePair(t)
	seedActivityType(t, q, pool, aType, 2)
	seedActivityType(t, q, pool, bType, 3)
	h := &AdminHandler{queries: q}

	env, body := getActivity(t, h, "type="+aType)
	if len(env.Data) != 2 {
		t.Fatalf("filtering by %s returned %d entries, want 2 (body: %s)", aType, len(env.Data), body)
	}
	for _, e := range env.Data {
		if e.EventType != aType {
			t.Errorf("filter leaked a %q row", e.EventType)
		}
	}
	// total_items must reflect the FILTERED set — the SPA would otherwise
	// advertise a page count for the unfiltered log.
	if env.TotalItems != 2 {
		t.Errorf("total_items = %d, want 2 (the filtered count)", env.TotalItems)
	}

	// The other type is still reachable, so the filter selects rather than
	// destroys.
	if env, _ := getActivity(t, h, "type="+bType); len(env.Data) != 3 {
		t.Errorf("filtering by %s returned %d entries, want 3", bType, len(env.Data))
	}

	// An unrecorded type is empty, not an error, and not the whole log.
	unknown, _ := getActivity(t, h, "type="+aType+"_nope")
	if len(unknown.Data) != 0 {
		t.Errorf("unknown type returned %d entries, want 0", len(unknown.Data))
	}
}
