package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/arr"
	"github.com/aurora-media/aurora/internal/models"
)

// TestAddMovieToRadarr_IdempotentWhenAlreadyPresent is the regression test for
// the audit H4 follow-up. The pending-recovery sweep re-runs dispatch for
// orphaned requests; if the title is ALREADY in Radarr (the orphan's original
// dispatch reached the API before the process died), a re-POST returns HTTP 400
// which doRequest maps to an error — previously flipping the request to a
// permanent 'failed'. addMovieToRadarr must instead pre-check GetMovie and, when
// the movie is present, return its existing id WITHOUT POSTing.
func TestAddMovieToRadarr_IdempotentWhenAlreadyPresent(t *testing.T) {
	var postCalled bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v3/movie"):
			// Radarr reports the movie already exists.
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"id":42,"tmdbId":603,"title":"The Matrix","hasFile":false}]`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v3/movie":
			postCalled = true
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`[{"errorMessage":"This movie has already been added"}]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	client := arr.NewRadarrClient(srv.URL, "test-key")
	h := &RequestHandler{}
	req := &models.Request{TMDBID: 603, Title: "The Matrix", Year: 1999, Quality1080p: true}

	id, err := h.addMovieToRadarr(context.Background(), req, client, "radarr")
	if err != nil {
		t.Fatalf("addMovieToRadarr returned error for an already-present movie: %v", err)
	}
	if postCalled {
		t.Error("addMovieToRadarr POSTed to add a movie that already exists; it should short-circuit on GetMovie")
	}
	if id != "radarr:42" {
		t.Errorf("job id = %q, want %q (the existing movie's id)", id, "radarr:42")
	}
}

// TestAddMovieToRadarr_AddsWhenAbsent is the positive control: when the movie is
// not yet in Radarr, addMovieToRadarr proceeds to add it normally.
func TestAddMovieToRadarr_AddsWhenAbsent(t *testing.T) {
	var postCalled bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v3/movie"):
			_, _ = w.Write([]byte(`[]`)) // not present
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v3/rootfolder"):
			_, _ = w.Write([]byte(`[{"id":1,"path":"/movies"}]`))
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v3/qualityprofile"):
			_, _ = w.Write([]byte(`[{"id":1,"name":"HD"}]`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v3/movie":
			postCalled = true
			_, _ = w.Write([]byte(`{"id":99,"tmdbId":603,"title":"The Matrix"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	client := arr.NewRadarrClient(srv.URL, "test-key")
	h := &RequestHandler{}
	req := &models.Request{TMDBID: 603, Title: "The Matrix", Year: 1999, Quality1080p: true}

	id, err := h.addMovieToRadarr(context.Background(), req, client, "radarr")
	if err != nil {
		t.Fatalf("addMovieToRadarr returned error: %v", err)
	}
	if !postCalled {
		t.Error("addMovieToRadarr did not POST to add an absent movie")
	}
	if id != "radarr:99" {
		t.Errorf("job id = %q, want %q (the newly-added movie's id)", id, "radarr:99")
	}
}
