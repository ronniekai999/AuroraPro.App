package api

// The library-health HANDLER. The policy beside it is pure and well covered;
// this is the wiring, which had no test anywhere — `grep '\.Health('` over
// internal/ returned nothing, and the nil-scanner narrowing it exists for was
// untested too.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/library"
	"github.com/aurora-media/aurora/internal/models"
	ws "github.com/aurora-media/aurora/internal/websocket"
)

func TestLibraryHealthHandlerReportsTheMistypedLibrary(t *testing.T) {
	q, pool := retypeHandlerDB(t)
	libID := seedRetypeLibrary(t, pool, 12) // enough titles to be judged, none matched
	s := library.NewScanner(config.ScannerConfig{}, q)
	h := NewLibraryHandler(q, s, ws.NewHub(nil), nil, nil)

	w := httptest.NewRecorder()
	h.Health(w, httptest.NewRequest(http.MethodGet, "/api/admin/library-health", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (%s)", w.Code, w.Body.String())
	}

	var rep LibraryHealthReport
	if err := json.Unmarshal(w.Body.Bytes(), &rep); err != nil {
		t.Fatalf("decode: %v", err)
	}
	var row *LibraryHealthRow
	for i := range rep.Libraries {
		if rep.Libraries[i].LibraryID == libID {
			row = &rep.Libraries[i]
		}
	}
	if row == nil {
		t.Fatalf("library %d missing from the report (%d rows)", libID, len(rep.Libraries))
	}
	if row.Items != 12 || row.Matched != 0 {
		t.Errorf("row reports %d/%d, want 12 items and 0 matched", row.Matched, row.Items)
	}
	if row.Warning == "" && rep.InstallWarning == "" {
		t.Error("a library with 12 titles and no provider metadata produced no warning at all — this is the #510 shape and the report's whole job")
	}
	if row.Type != models.LibraryMovies {
		t.Errorf("row type = %q; the warning names the type, so it has to ride along", row.Type)
	}
}

// h.scanner is a *library.Scanner, so passing it straight into the
// ScanProgressSource interface wraps a nil POINTER in a non-nil interface and
// the adapter's nil check misses it — the call then nil-derefs on the scanner's
// mutex. A review demonstrated the panic. The handler narrows it first; this is
// the pin for that, and the untyped-nil test beside the policy cannot reach it.
func TestLibraryHealthHandlerSurvivesANilScanner(t *testing.T) {
	q, pool := retypeHandlerDB(t)
	seedRetypeLibrary(t, pool, 12)
	h := NewLibraryHandler(q, nil, ws.NewHub(nil), nil, nil)

	w := httptest.NewRecorder()
	h.Health(w, httptest.NewRequest(http.MethodGet, "/api/admin/library-health", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d with a nil scanner, want 200 (%s)", w.Code, w.Body.String())
	}
	var rep LibraryHealthReport
	if err := json.Unmarshal(w.Body.Bytes(), &rep); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, l := range rep.Libraries {
		if l.Scanning {
			t.Errorf("library %d reported as scanning with no scanner; 'unknown' must not read as 'busy', which would silence the report", l.LibraryID)
		}
	}
}
