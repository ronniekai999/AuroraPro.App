package metadata

import (
	"encoding/json"
	"testing"
)

func TestFirstNamed(t *testing.T) {
	if got := firstNamed(nil); got != nil {
		t.Fatalf("nil slice want nil, got %q", *got)
	}
	if got := firstNamed([]TMDBNamedEntity{{Name: ""}, {Name: "Warner Bros."}}); got == nil || *got != "Warner Bros." {
		t.Fatalf("want Warner Bros. (skipping empty), got %v", got)
	}
	if got := firstNamed([]TMDBNamedEntity{{Name: ""}}); got != nil {
		t.Fatalf("all-empty want nil, got %q", *got)
	}
}

func TestFirstNonEmpty(t *testing.T) {
	if got := firstNonEmpty("2022-11-23", "2020-01-01"); got == nil || *got != "2022-11-23" {
		t.Fatalf("want first 2022-11-23, got %v", got)
	}
	if got := firstNonEmpty("", "2019-11-12"); got == nil || *got != "2019-11-12" {
		t.Fatalf("want fallback 2019-11-12, got %v", got)
	}
	if got := firstNonEmpty("", ""); got != nil {
		t.Fatalf("both empty want nil, got %q", *got)
	}
}

// Confirms production_companies / networks / dates unmarshal off the TMDB
// detail response (via the embedded base struct) for both TV and movies.
func TestTMDBDetailParsesCompaniesAndNetworks(t *testing.T) {
	const tvJSON = `{
		"id": 119051, "name": "Wednesday", "first_air_date": "2022-11-23",
		"production_companies": [{"id": 1, "name": "MGM Television"}],
		"networks": [{"id": 213, "name": "Netflix"}]
	}`
	var tv TMDBTVDetail
	if err := json.Unmarshal([]byte(tvJSON), &tv); err != nil {
		t.Fatalf("unmarshal tv: %v", err)
	}
	if got := firstNamed(tv.Networks); got == nil || *got != "Netflix" {
		t.Fatalf("network want Netflix, got %v", got)
	}
	if got := firstNamed(tv.ProductionCompanies); got == nil || *got != "MGM Television" {
		t.Fatalf("studio want MGM Television, got %v", got)
	}
	if got := firstNonEmpty(tv.ReleaseDate, tv.FirstAirDate); got == nil || *got != "2022-11-23" {
		t.Fatalf("premiered want 2022-11-23, got %v", got)
	}

	const movieJSON = `{
		"id": 1634, "title": "Free Willy", "release_date": "1993-07-16",
		"production_companies": [{"id": 2, "name": "Warner Bros. Pictures"}]
	}`
	var mv TMDBMovieDetail
	if err := json.Unmarshal([]byte(movieJSON), &mv); err != nil {
		t.Fatalf("unmarshal movie: %v", err)
	}
	if got := firstNamed(mv.ProductionCompanies); got == nil || *got != "Warner Bros. Pictures" {
		t.Fatalf("studio want Warner Bros. Pictures, got %v", got)
	}
	if got := firstNamed(mv.Networks); got != nil {
		t.Fatalf("movie networks want nil, got %q", *got)
	}
	if got := firstNonEmpty(mv.ReleaseDate, mv.FirstAirDate); got == nil || *got != "1993-07-16" {
		t.Fatalf("released want 1993-07-16, got %v", got)
	}
}
