package api

// Handler-level integration tests for /api/media/search routing (issue #207).
// These exercise the real trigram path against Postgres plus a controllable
// fake semantic searcher, so the literal-first / semantic-first / fallback /
// rescue control flow is covered end to end — not just the pure decision
// helpers in search_routing_test.go.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run (skipped otherwise),
// reusing requireRequestTestDB/reqTestSuffix/seedReqUser from
// request_approval_test.go (same package). pg_trgm must be installed in the
// test DB (it is in every Aurora schema — the % operator powers SearchMedia).
//
// Assertions deliberately check POSITIVE presence + the X-Search-Mode header +
// whether the fake LLM was invoked, and avoid "item X is absent" checks: all
// seeded titles share one random suffix, so trigram similarity can legitimately
// cross-match them. "Semantic did/didn't serve this" is proven by the
// fake.called flag, not by item absence.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// fakeSemantic is a controllable SemanticSearcher for routing tests.
type fakeSemantic struct {
	hits   []SemanticHit
	err    error
	called bool
}

func (f *fakeSemantic) Search(_ context.Context, _ string, _ int) ([]SemanticHit, error) {
	f.called = true
	if f.err != nil {
		return nil, f.err
	}
	return f.hits, nil
}

func seedSearchMovie(t *testing.T, q *db.Queries, libID int64, title string) *models.MediaItem {
	t.Helper()
	item := &models.MediaItem{
		LibraryID: libID,
		Type:      models.MediaType("movie"),
		Title:     title,
		SortTitle: title,
		Year:      1996,
	}
	if err := q.UpsertMediaItem(context.Background(), item); err != nil {
		t.Fatalf("seed media item %q: %v", title, err)
	}
	return item
}

func TestSearchHandler_Routing(t *testing.T) {
	q := requireRequestTestDB(t)
	userID := seedReqUser(t, q)
	suffix := reqTestSuffix(t)

	lib := &models.Library{
		Name:         "search_test_" + suffix,
		Type:         models.LibraryType("movie"),
		Paths:        []string{"/tmp/search_test_" + suffix},
		ScanInterval: 60,
		OwnerID:      userID,
	}
	if err := q.CreateLibrary(context.Background(), lib); err != nil {
		t.Fatalf("create library: %v", err)
	}
	// DeleteLibrary CASCADEs the seeded media_items.
	t.Cleanup(func() { _, _ = q.DeleteLibrary(context.Background(), lib.ID) })

	titleItem := seedSearchMovie(t, q, lib.ID, "A Time to Kill "+suffix) // #207: long exact title, no marker
	likeItem := seedSearchMovie(t, q, lib.ID, "As You Like It "+suffix)  // title that trips the "like" marker
	semItem := seedSearchMovie(t, q, lib.ID, "Semantic Sentinel "+suffix) // what the fake LLM returns

	search := func(t *testing.T, fake *fakeSemantic, rawQuery string) (*httptest.ResponseRecorder, []*models.MediaItem) {
		t.Helper()
		h := NewMediaHandler(q, nil)
		if fake != nil {
			h.SetSemanticSearcher(fake)
		}
		req := httptest.NewRequest(http.MethodGet, "/api/media/search?"+rawQuery, nil)
		rec := httptest.NewRecorder()
		h.Search(rec, req)
		var got []*models.MediaItem
		if rec.Code == http.StatusOK {
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode body: %v (body=%s)", err, rec.Body.String())
			}
		}
		return rec, got
	}
	has := func(items []*models.MediaItem, want string) bool {
		for _, it := range items {
			if it != nil && it.Title == want {
				return true
			}
		}
		return false
	}
	// SearchMedia scans the whole catalog (no library_id filter), so a fixed
	// gibberish string could in theory be matched by a stray row on a shared
	// CI database. Embedding the per-test random suffix makes the query
	// globally unique — it cannot be a substring of, or trigram-similar to,
	// any pre-existing title/overview.
	noMatch := "zqxvno" + suffix + "match"

	// #207: an exact, long, marker-less title must resolve via trigram even
	// though a semantic searcher is configured — and must NOT pay the LLM.
	t.Run("exact_long_title_uses_trigram", func(t *testing.T) {
		fake := &fakeSemantic{hits: []SemanticHit{{Item: semItem}}}
		rec, items := search(t, fake, "q="+url.QueryEscape("A Time to Kill "+suffix))
		if got := rec.Header().Get("X-Search-Mode"); got != "literal" {
			t.Errorf("X-Search-Mode = %q, want literal", got)
		}
		if fake.called {
			t.Error("semantic searcher was invoked for an exact title lookup")
		}
		if !has(items, titleItem.Title) {
			t.Errorf("expected %q in results; got %d items", titleItem.Title, len(items))
		}
	})

	// Explicit recommendation query → semantic-first.
	t.Run("recommendation_query_semantic_first", func(t *testing.T) {
		fake := &fakeSemantic{hits: []SemanticHit{{Item: semItem}}}
		rec, items := search(t, fake, "q="+url.QueryEscape("movies like Severance"))
		if got := rec.Header().Get("X-Search-Mode"); got != "semantic" {
			t.Errorf("X-Search-Mode = %q, want semantic", got)
		}
		if !fake.called {
			t.Error("expected semantic-first for a 'movies like X' query")
		}
		if !has(items, semItem.Title) {
			t.Errorf("expected semantic sentinel in results; got %d items", len(items))
		}
	})

	// Marker-less descriptive query with no library hit → empty-trigram fallback.
	t.Run("marker_less_no_match_falls_back_to_semantic", func(t *testing.T) {
		// Precondition: the fallback only fires when trigram is genuinely empty.
		if pre, _ := q.SearchMedia(context.Background(), noMatch, 5); len(pre) != 0 {
			t.Skipf("catalog unexpectedly matches %q (%d rows); fallback precondition unmet", noMatch, len(pre))
		}
		fake := &fakeSemantic{hits: []SemanticHit{{Item: semItem}}}
		rec, items := search(t, fake, "q="+url.QueryEscape(noMatch))
		if got := rec.Header().Get("X-Search-Mode"); got != "semantic" {
			t.Errorf("X-Search-Mode = %q, want semantic (empty-trigram fallback)", got)
		}
		if !fake.called {
			t.Error("expected empty-trigram fallback to invoke semantic")
		}
		if !has(items, semItem.Title) {
			t.Errorf("expected semantic fallback sentinel; got %d items", len(items))
		}
	})

	// The deep-debug fix: a title that trips a marker ("As You Like It") routes
	// semantic-first, the LLM returns nothing, and trigram RESCUES the exact
	// title instead of returning an empty page.
	t.Run("marker_substring_title_rescued_by_trigram", func(t *testing.T) {
		fake := &fakeSemantic{hits: nil} // semantic ok, but empty
		rec, items := search(t, fake, "q="+url.QueryEscape("As You Like It "+suffix))
		if !fake.called {
			t.Error("expected semantic-first for a query containing 'like'")
		}
		if got := rec.Header().Get("X-Search-Mode"); got != "literal" {
			t.Errorf("X-Search-Mode = %q, want literal (trigram rescue)", got)
		}
		if !has(items, likeItem.Title) {
			t.Errorf("expected trigram rescue to return %q; got %d items", likeItem.Title, len(items))
		}
	})

	// ?mode=literal opts out of the LLM entirely, including the empty fallback.
	t.Run("mode_literal_never_invokes_semantic", func(t *testing.T) {
		fake := &fakeSemantic{hits: []SemanticHit{{Item: semItem}}}
		rec, _ := search(t, fake, "q="+url.QueryEscape(noMatch)+"&mode=literal")
		if fake.called {
			t.Error("semantic searcher invoked despite mode=literal")
		}
		if got := rec.Header().Get("X-Search-Mode"); got != "literal" {
			t.Errorf("X-Search-Mode = %q, want literal", got)
		}
	})
}
