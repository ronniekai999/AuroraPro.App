package api

// The gate in front of the catalog purge. The destructive half lives in
// internal/db and is pinned against a real Postgres; this covers the checks that
// decide whether the purge runs at all.
//
// Deliberately pure. A case that needed a database or a scanner to reject it
// would be a case this gate does not actually cover.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

func retypeCount(n int64) *int64 { return &n }

func TestValidateRetypeRequestRefusesBeforeAnythingCanBeDeleted(t *testing.T) {
	cases := []struct {
		name string
		req  RetypeRequest
		// must appears in the refusal, so an admin is told what to send rather
		// than just told no.
		must string
	}{
		{
			// The interlock is the whole safety model: an absent one must never
			// read as "delete whatever is there now".
			name: "no expected_items",
			req:  RetypeRequest{Type: "show"},
			must: "expected_items is required",
		},
		{
			name: "negative expected_items",
			req:  RetypeRequest{Type: "show", ExpectedItems: retypeCount(-1)},
			must: "negative",
		},
		{
			name: "unknown type",
			req:  RetypeRequest{Type: "documentaries", ExpectedItems: retypeCount(0)},
			must: "movie",
		},
		{
			name: "empty type",
			req:  RetypeRequest{Type: "", ExpectedItems: retypeCount(0)},
			must: "movie",
		},
		{
			// A garbage type reaching the query would make `type <> <garbage>`
			// match every row — the whole library, including correctly-typed
			// rows. internal/db refuses it too; this is the outer of the two.
			name: "type that is a media type, not a library type",
			req:  RetypeRequest{Type: "episode", ExpectedItems: retypeCount(0)},
			must: "movie",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, reason := validateRetypeRequest(c.req)
			if reason == "" {
				t.Fatal("accepted; this request would have reached the purge")
			}
			if !strings.Contains(reason, c.must) {
				t.Errorf("refusal %q does not mention %q", reason, c.must)
			}
		})
	}
}

func TestValidateRetypeRequestAcceptsZeroAsARealApproval(t *testing.T) {
	// Zero is a legitimate answer — a library already entirely of the target
	// type has nothing to purge — which is why the field is a POINTER. As a
	// plain int64, an omitted interlock and an approved zero are the same value,
	// so a request that forgot the interlock would sail through.
	target, expected, reason := validateRetypeRequest(RetypeRequest{Type: "show", ExpectedItems: retypeCount(0)})
	if reason != "" {
		t.Fatalf("expected_items=0 was refused (%q); zero is an approval, not an absence", reason)
	}
	if target != models.LibraryShows {
		t.Errorf("target = %q, want %q", target, models.LibraryShows)
	}
	if expected != 0 {
		t.Errorf("expected = %d, want 0", expected)
	}

	// And both real types round-trip, with surrounding whitespace tolerated —
	// the value comes from a form.
	for raw, want := range map[string]models.LibraryType{
		"movie": models.LibraryMovies, " show ": models.LibraryShows,
	} {
		got, n, reason := validateRetypeRequest(RetypeRequest{Type: raw, ExpectedItems: retypeCount(7)})
		if reason != "" || got != want || n != 7 {
			t.Errorf("validate(%q) = (%q, %d, %q), want (%q, 7, \"\")", raw, got, n, reason, want)
		}
	}
}

func TestRetypeRejectsAMalformedBodyWithoutTouchingAnything(t *testing.T) {
	// A handler with no queries and no scanner: reaching either would nil-panic,
	// which is the assertion. A malformed body must not get that far.
	h := &LibraryHandler{}
	w := httptest.NewRecorder()
	h.Retype(w, httptest.NewRequest(http.MethodPost, "/api/libraries/1/retype", strings.NewReader("{")))
	if w.Code != http.StatusBadRequest {
		t.Errorf("status %d for a malformed body, want 400 (%s)", w.Code, w.Body.String())
	}
}

func TestRetypePreviewRejectsABadTargetType(t *testing.T) {
	h := &LibraryHandler{}
	for _, q := range []string{"", "?type=", "?type=documentaries", "?type=episode"} {
		w := httptest.NewRecorder()
		h.RetypePreview(w, httptest.NewRequest(http.MethodGet, "/api/libraries/1/retype/preview"+q, nil))
		if w.Code != http.StatusBadRequest {
			t.Errorf("preview with %q returned %d, want 400", q, w.Code)
		}
	}
}
