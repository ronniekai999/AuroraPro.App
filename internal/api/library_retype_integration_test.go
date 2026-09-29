package api

// The retype HANDLER, end to end against a real database and a real scanner.
//
// The pure validation tests beside this one cover the gate; they do not cover
// the handler reaching the purge. A review deleted the scan-slot claim
// (`if !h.scanner.TryStartScan(...)` -> `if false`) and the whole api package
// stayed green — on the path that deletes catalog rows.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/library"
	"github.com/aurora-media/aurora/internal/models"
	ws "github.com/aurora-media/aurora/internal/websocket"
)

func retypeHandlerDB(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping retype handler integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping: %v", err)
	}
	t.Cleanup(pool.Close)
	return db.NewQueries(pool), pool
}

// seedRetypeLibrary builds a library in the #510 shape and returns its id.
func seedRetypeLibrary(t *testing.T, pool *pgxpool.Pool, movies int) int64 {
	t.Helper()
	ctx := context.Background()
	sfx := strconv.FormatInt(time.Now().UnixNano(), 36)

	var ownerID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash) VALUES ($1,$2,'x') RETURNING id`,
		"retypeh_"+sfx, "retypeh_"+sfx+"@example.com").Scan(&ownerID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, ownerID) })

	var libID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO libraries (name, type, paths, owner_id) VALUES ($1,'movie',$2,$3) RETURNING id`,
		"retypeh_lib_"+sfx, []string{t.TempDir()}, ownerID).Scan(&libID); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id=$1`, libID) })

	for i := 0; i < movies; i++ {
		if _, err := pool.Exec(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
			 VALUES ($1,'movie',$2,$2,'',0,0,'',0)`, libID, "Retype H "+sfx+" "+strconv.Itoa(i)); err != nil {
			t.Fatalf("seed item: %v", err)
		}
	}
	return libID
}

func retypeHandler(t *testing.T, q *db.Queries) (*LibraryHandler, *library.Scanner) {
	t.Helper()
	s := library.NewScanner(config.ScannerConfig{FFprobePath: "/nonexistent/ffprobe", Workers: 1}, q)
	h := NewLibraryHandler(q, s, ws.NewHub(nil), nil, nil)
	return h, s
}

func retypeReq(t *testing.T, method, url, body string, libID int64) *http.Request {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, url, nil)
	} else {
		r = httptest.NewRequest(method, url, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", strconv.FormatInt(libID, 10))
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

func TestRetypeHandlerRefusesWhileAScanIsRunning(t *testing.T) {
	q, pool := retypeHandlerDB(t)
	libID := seedRetypeLibrary(t, pool, 3)
	h, s := retypeHandler(t, q)

	// Something else is already scanning. Letting the purge run alongside it
	// would delete rows the scan is writing, and the scan would then keep
	// walking the library under the OLD parser.
	if !s.TryStartScan(libID) {
		t.Fatal("could not claim the slot for the fixture")
	}

	w := httptest.NewRecorder()
	h.Retype(w, retypeReq(t, http.MethodPost, "/x", `{"type":"show","expected_items":3}`, libID))

	if w.Code != http.StatusConflict {
		t.Errorf("status %d while a scan was running, want 409 (%s)", w.Code, w.Body.String())
	}
	var n int64
	if err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM media_items WHERE library_id=$1`, libID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 3 {
		t.Errorf("%d items remain after a refused retype, want 3", n)
	}
	// And the running scan still owns its slot.
	if s.TryStartScan(libID) {
		t.Error("the refused retype released a slot held by a running scan")
	}
}

func TestRetypeHandlerMapsAStaleCountTo409AndFreesTheSlot(t *testing.T) {
	q, pool := retypeHandlerDB(t)
	libID := seedRetypeLibrary(t, pool, 3)
	h, s := retypeHandler(t, q)

	w := httptest.NewRecorder()
	h.Retype(w, retypeReq(t, http.MethodPost, "/x", `{"type":"show","expected_items":99}`, libID))

	if w.Code != http.StatusConflict {
		t.Fatalf("status %d for a stale count, want 409 (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "preview") {
		t.Errorf("409 body does not tell the admin to re-run the preview: %s", w.Body.String())
	}
	var n int64
	if err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM media_items WHERE library_id=$1`, libID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 3 {
		t.Errorf("%d items remain after a refused retype, want 3", n)
	}
	// The slot was claimed and must be given back, or this library can never be
	// scanned again for the life of the process — and the health report would
	// read it as busy and stay silent about it.
	if !s.TryStartScan(libID) {
		t.Error("a refused retype left the library holding its scan slot")
	}
}

func TestRetypeHandlerPurgesAndRescansOnSuccess(t *testing.T) {
	q, pool := retypeHandlerDB(t)
	libID := seedRetypeLibrary(t, pool, 3)
	h, s := retypeHandler(t, q)

	w := httptest.NewRecorder()
	h.Retype(w, retypeReq(t, http.MethodPost, "/x", `{"type":"show","expected_items":3}`, libID))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		ItemsDeleted int64  `json:"items_deleted"`
		Rescanning   bool   `json:"rescanning"`
		Type         string `json:"type"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ItemsDeleted != 3 || !resp.Rescanning || resp.Type != string(models.LibraryShows) {
		t.Errorf("response = %+v, want 3 deleted / rescanning / show", resp)
	}

	var typ string
	var n int64
	ctx := context.Background()
	if err := pool.QueryRow(ctx, `SELECT type FROM libraries WHERE id=$1`, libID).Scan(&typ); err != nil {
		t.Fatalf("read type: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM media_items WHERE library_id=$1`, libID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if typ != string(models.LibraryShows) {
		t.Errorf("library type = %q, want show", typ)
	}
	if n != 0 {
		t.Errorf("%d items survived the purge, want 0", n)
	}

	// The rescan runs on the slot the handler already held, so nothing else can
	// scan the library of the old shape in between. It walks an empty temp dir,
	// so it finishes quickly and gives the slot back.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if s.GetProgress(libID).Status != models.ScanRunning {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if st := s.GetProgress(libID).Status; st == models.ScanRunning {
		t.Error("the rescan never finished; the slot is still held")
	}
}

func TestRetypeHandlerPreviewReportsCasualties(t *testing.T) {
	q, pool := retypeHandlerDB(t)
	libID := seedRetypeLibrary(t, pool, 2)
	h, _ := retypeHandler(t, q)

	w := httptest.NewRecorder()
	h.RetypePreview(w, retypeReq(t, http.MethodGet, "/x?type=show", "", libID))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (%s)", w.Code, w.Body.String())
	}
	var p db.RetypePreview
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.ItemsToDelete != 2 {
		t.Errorf("items_to_delete = %d, want 2", p.ItemsToDelete)
	}
	if p.CurrentType != models.LibraryMovies || p.TargetType != models.LibraryShows {
		t.Errorf("preview reports %s -> %s", p.CurrentType, p.TargetType)
	}

	// Nothing was deleted by a preview.
	var n int64
	if err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM media_items WHERE library_id=$1`, libID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Errorf("%d items remain after a preview, want 2", n)
	}
}

func TestRetypeHandlerIsA404ForAMissingLibrary(t *testing.T) {
	q, _ := retypeHandlerDB(t)
	h, _ := retypeHandler(t, q)

	for _, tc := range []struct {
		name string
		call func(w *httptest.ResponseRecorder)
	}{
		{"preview", func(w *httptest.ResponseRecorder) {
			h.RetypePreview(w, retypeReq(t, http.MethodGet, "/x?type=show", "", 0))
		}},
		{"retype", func(w *httptest.ResponseRecorder) {
			h.Retype(w, retypeReq(t, http.MethodPost, "/x", `{"type":"show","expected_items":0}`, 0))
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			tc.call(w)
			if w.Code != http.StatusNotFound {
				t.Errorf("status %d for a missing library, want 404 (%s)", w.Code, w.Body.String())
			}
		})
	}
}

// TestRetypeHandlerRePointsTheWatcher is the pin for the defect a review
// demonstrated end to end, and which nothing in the branch covered: the handler
// built its test watcher as nil, so deleting the whole re-point block left the
// suite green.
//
// Watcher.WatchLibrary stores the *models.Library it is handed as a SNAPSHOT,
// and it is only ever called at boot and on library creation. Both the periodic
// tick and the fsnotify debounce pass that snapshot to ScanLibrary, which
// branches on lib.Type rather than re-reading the database — so without a
// re-point the first file event after a successful retype re-scans under the OLD
// parser and re-creates the wrong-typed rows the purge just removed, with their
// files in the table that type implies, unreachable by pruneDeletedFiles.
func TestRetypeHandlerRePointsTheWatcher(t *testing.T) {
	q, pool := retypeHandlerDB(t)
	libID := seedRetypeLibrary(t, pool, 2)
	s := library.NewScanner(config.ScannerConfig{FFprobePath: "/nonexistent/ffprobe", Workers: 1}, q)
	w := library.NewWatcher(config.ScannerConfig{}, s, func(*models.Library) {})
	t.Cleanup(w.StopAll)

	lib, err := q.GetLibrary(context.Background(), libID)
	if err != nil || lib == nil {
		t.Fatalf("read library: %v", err)
	}
	if err := w.WatchLibrary(context.Background(), lib); err != nil {
		t.Fatalf("seed watch: %v", err)
	}
	if got := w.WatchedLibrary(libID); got == nil || got.Type != models.LibraryMovies {
		t.Fatalf("precondition: watcher holds %v, want a movie library", got)
	}

	// Capture what the watcher held when the SCAN first reported progress. The
	// ordering — re-point, then scan — is what the code comment and CLAUDE.md
	// both make load-bearing, and polling for the final state cannot see it: an
	// empty temp dir scans in milliseconds, so moving the re-point after
	// ScanLibrary passes a poll either way. A review showed that mutation
	// surviving.
	typeAtFirstProgress := make(chan models.LibraryType, 1)
	h := NewLibraryHandler(q, s, ws.NewHub(nil), w, nil)
	h.onRescanProgressForTest = func() {
		if held := w.WatchedLibrary(libID); held != nil {
			select {
			case typeAtFirstProgress <- held.Type:
			default:
			}
		}
	}

	rec := httptest.NewRecorder()
	h.Retype(rec, retypeReq(t, http.MethodPost, "/x", `{"type":"show","expected_items":2}`, libID))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	select {
	case got := <-typeAtFirstProgress:
		if got != models.LibraryShows {
			t.Errorf("the scan started while the watcher still held %q; the re-point must precede ScanLibrary, or a file event during the scan queues another one under the old parser", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the rescan never reported progress")
	}

	// The re-point runs in the rescan goroutine — deliberately off the request
	// path, because WatchLibrary walks every library path and doing that inline
	// after a committed purge is what caused 504s on LibraryHandler.Create.
	deadline := time.Now().Add(10 * time.Second)
	var held *models.Library
	for time.Now().Before(deadline) {
		held = w.WatchedLibrary(libID)
		if held != nil && held.Type == models.LibraryShows {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if held == nil {
		t.Fatal("the library is no longer watched at all after a retype")
	}
	if held.Type != models.LibraryShows {
		t.Errorf("the watcher still holds type %q after a retype to show; the next file event or periodic tick would re-scan under the old parser and re-create the state the purge just removed", held.Type)
	}
}
